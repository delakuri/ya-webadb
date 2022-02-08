import type { Adb, AdbBufferedStream } from "@yume-chan/adb";
import Struct, { placeholder } from "@yume-chan/struct";
import { AndroidCodecLevel, AndroidCodecProfile } from "../../codec";
import { ScrcpyClientConnection, ScrcpyClientConnectionOptions, ScrcpyClientForwardConnection, ScrcpyClientReverseConnection } from "../../connection";
import { AndroidKeyEventAction, ScrcpyControlMessageType } from "../../message";
import type { ScrcpyInjectScrollControlMessage1_22 } from "../1_22";
import { ScrcpyLogLevel, ScrcpyOptions, ScrcpyOptionValue, ScrcpyScreenOrientation, toScrcpyOptionValue, VideoStreamPacket } from "../common";
import { parse_sequence_parameter_set } from "./sps";

export interface CodecOptionsType {
    profile: AndroidCodecProfile;

    level: AndroidCodecLevel;
}

export class CodecOptions implements ScrcpyOptionValue {
    public value: Partial<CodecOptionsType>;

    public constructor(value: Partial<CodecOptionsType>) {
        this.value = value;
    }

    public toOptionValue(): string | undefined {
        const entries = Object.entries(this.value)
            .filter(([key, value]) => value !== undefined);

        if (entries.length === 0) {
            return undefined;
        }

        return entries
            .map(([key, value]) => `${key}=${value}`)
            .join(',');
    }
}

export interface ScrcpyOptions1_16Type {
    logLevel: ScrcpyLogLevel;

    /**
     * The maximum value of both width and height.
     */
    maxSize: number;

    bitRate: number;

    /**
     * 0 for unlimited.
     *
     * @default 0
     */
    maxFps: number;

    /**
     * The orientation of the video stream.
     *
     * It will not keep the device screen in specific orientation,
     * only the captured video will in this orientation.
     */
    lockVideoOrientation: ScrcpyScreenOrientation;

    tunnelForward: boolean;

    crop: string;

    /**
     * Send PTS so that the client may record properly
     *
     * Note: When `sendFrameMeta: false` is specified,
     * `onChangeEncoding` event won't fire and `onVideoData` event doesn't
     * merge sps/pps frame and first video frame. Which means you can't use
     * the shipped decoders to render the video
     * (You can still record the stream into a file).
     *
     * @default true
     */
    sendFrameMeta: boolean;

    /**
     * @default true
     */
    control: boolean;

    displayId: number;

    showTouches: boolean;

    stayAwake: boolean;

    codecOptions: CodecOptions;

    encoderName: string;
}

export const VideoPacket =
    new Struct()
        .int64('pts')
        .uint32('size')
        .arrayBuffer('data', { lengthField: 'size' });

export const NoPts = BigInt(-1);

export const ScrcpyBackOrScreenOnEvent1_16 =
    new Struct()
        .uint8('type', placeholder<ScrcpyControlMessageType.BackOrScreenOn>());

export const ScrcpyInjectScrollControlMessage1_16 =
    new Struct()
        .uint8('type', ScrcpyControlMessageType.InjectScroll as const)
        .uint32('pointerX')
        .uint32('pointerY')
        .uint16('screenWidth')
        .uint16('screenHeight')
        .int32('scrollX')
        .int32('scrollY');

export class ScrcpyOptions1_16<T extends ScrcpyOptions1_16Type = ScrcpyOptions1_16Type> implements ScrcpyOptions<T> {
    public value: Partial<T>;

    private _streamHeader: ArrayBuffer | undefined;

    public constructor(value: Partial<ScrcpyOptions1_16Type>) {
        if (new.target === ScrcpyOptions1_16 &&
            value.logLevel === ScrcpyLogLevel.Verbose) {
            value.logLevel = ScrcpyLogLevel.Debug;
        }

        if (new.target === ScrcpyOptions1_16 &&
            value.lockVideoOrientation === ScrcpyScreenOrientation.Initial) {
            value.lockVideoOrientation = ScrcpyScreenOrientation.Unlocked;
        }

        this.value = value as Partial<T>;
    }

    protected getArgumentOrder(): (keyof T)[] {
        return [
            'logLevel',
            'maxSize',
            'bitRate',
            'maxFps',
            'lockVideoOrientation',
            'tunnelForward',
            'crop',
            'sendFrameMeta',
            'control',
            'displayId',
            'showTouches',
            'stayAwake',
            'codecOptions',
            'encoderName',
        ];
    }

    protected getDefaultValue(): T {
        return {
            logLevel: ScrcpyLogLevel.Debug,
            maxSize: 0,
            bitRate: 8_000_000,
            maxFps: 0,
            lockVideoOrientation: ScrcpyScreenOrientation.Unlocked,
            tunnelForward: false,
            crop: '-',
            sendFrameMeta: true,
            control: true,
            displayId: 0,
            showTouches: false,
            stayAwake: false,
            codecOptions: new CodecOptions({}),
            encoderName: '-',
        } as T;
    }

    public formatServerArguments(): string[] {
        const defaults = this.getDefaultValue();
        return this.getArgumentOrder()
            .map(key => toScrcpyOptionValue(this.value[key] || defaults[key], '-'));
    }

    public createConnection(device: Adb): ScrcpyClientConnection {
        const options: ScrcpyClientConnectionOptions = {
            // Old scrcpy connection always have control stream no matter what the option is
            control: true,
            sendDummyByte: true,
            sendDeviceMeta: true,
        };
        if (this.value.tunnelForward) {
            return new ScrcpyClientForwardConnection(device, options);
        } else {
            return new ScrcpyClientReverseConnection(device, options);
        }
    }

    public getOutputEncoderNameRegex(): RegExp {
        return /\s+scrcpy --encoder-name '(.*?)'/;
    }

    public async parseVideoStream(stream: AdbBufferedStream): Promise<VideoStreamPacket> {
        if (this.value.sendFrameMeta === false) {
            return {
                videoData: await stream.read(1 * 1024 * 1024, true),
            };
        }

        const { pts, data } = await VideoPacket.deserialize(stream);
        if (!data || data.byteLength === 0) {
            return {};
        }

        if (pts === NoPts) {
            const sequenceParameterSet = parse_sequence_parameter_set(data.slice(0));

            const {
                profile_idc: profileIndex,
                constraint_set: constraintSet,
                level_idc: levelIndex,
                pic_width_in_mbs_minus1,
                pic_height_in_map_units_minus1,
                frame_mbs_only_flag,
                frame_crop_left_offset,
                frame_crop_right_offset,
                frame_crop_top_offset,
                frame_crop_bottom_offset,
            } = sequenceParameterSet;

            const encodedWidth = (pic_width_in_mbs_minus1 + 1) * 16;
            const encodedHeight = (pic_height_in_map_units_minus1 + 1) * (2 - frame_mbs_only_flag) * 16;
            const cropLeft = frame_crop_left_offset * 2;
            const cropRight = frame_crop_right_offset * 2;
            const cropTop = frame_crop_top_offset * 2;
            const cropBottom = frame_crop_bottom_offset * 2;

            const croppedWidth = encodedWidth - cropLeft - cropRight;
            const croppedHeight = encodedHeight - cropTop - cropBottom;

            this._streamHeader = data;
            return {
                encodingInfo: {
                    profileIndex,
                    constraintSet,
                    levelIndex,
                    encodedWidth,
                    encodedHeight,
                    cropLeft,
                    cropRight,
                    cropTop,
                    cropBottom,
                    croppedWidth,
                    croppedHeight,
                }
            };
        }

        let array: Uint8Array;
        if (this._streamHeader) {
            array = new Uint8Array(this._streamHeader.byteLength + data!.byteLength);
            array.set(new Uint8Array(this._streamHeader));
            array.set(new Uint8Array(data!), this._streamHeader.byteLength);
            this._streamHeader = undefined;
        } else {
            array = new Uint8Array(data!);
        }

        return {
            videoData: array.buffer,
        };
    }

    public serializeBackOrScreenOnControlMessage(action: AndroidKeyEventAction, device: Adb) {
        if (action === AndroidKeyEventAction.Down) {
            return ScrcpyBackOrScreenOnEvent1_16.serialize(
                { type: ScrcpyControlMessageType.BackOrScreenOn },
            );
        }

        return undefined;
    }

    public serializeInjectScrollControlMessage(
        message: ScrcpyInjectScrollControlMessage1_22,
    ): ArrayBuffer {
        return ScrcpyInjectScrollControlMessage1_16.serialize(message);
    }
}