import { StatsWriter } from "../entries/StatsStorage";
import { Collector } from "../Collector";
import { SfuSctpChannel } from "@observertc/schemas";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../utils/logger";
import { Collectors } from "../Collectors";
import { MediasoupDataConsumer } from "./MediasoupTypes";
import { Appendix } from "../entries/StatsEntryInterfaces";

const logger = createLogger(`MediasoupCollector`);

export type MediasoupDataConsumerCollectorConfig = {
    /**
     * a supplier lambda function provides information if the collector should poll stas or not
     * 
     * DEFAULT: undefined, which means it will not poll measurements
     */
    pollStats?: () => boolean;

    /**
     * Add arbitrary data to the inboundRtpEntry
     */
    appendix?: Appendix;
}

const supplyDefaultConfig = () => {
    const result: MediasoupDataConsumerCollectorConfig = {
    }
    return result;
}

const NO_REPORT_SSRC = 0xDEADBEEF;

export class MediasoupDataConsumerCollector implements Collector {
    public readonly id = uuidv4();
    private _parent: Collectors;
    private _closed = false;
    private _config: MediasoupDataConsumerCollectorConfig;
    private _statsWriter?: StatsWriter;
    private _transportId: string;
    private _internal: boolean;
    private _ssrcToPadIds = new Map<number, string>();
    private _dataConsumer: MediasoupDataConsumer;
    private _correspondCollector?: Collector
    public constructor(
        parent: Collectors,
        dataConsumer: MediasoupDataConsumer,
        transportId: string,
        internal: boolean,
        config?: MediasoupDataConsumerCollectorConfig,
        correspondCollector?: Collector
    ) {
        this.id = `mediasoup-dataConsumer-${dataConsumer.id}`;
        this._parent = parent;
        this._dataConsumer = dataConsumer;
        this._transportId = transportId;
        this._internal = internal;
        this._config = Object.assign(supplyDefaultConfig(), config);
        this._correspondCollector = correspondCollector;

        const dataConsumerId = this._dataConsumer.id;
        this._dataConsumer.observer.once("close", () => {
            this.close();
            logger.debug(`DataConsumer ${dataConsumerId} on transport ${transportId} is removed`);
        });
        logger.debug(`DataConsumer ${dataConsumerId} on transport ${transportId} is added`);
    }

    public setStatsWriter(value: StatsWriter | null) {
        if (this._statsWriter) {
            logger.warn(`StatsWriter has already been set`);
            return;
        }
        if (value === null) {
            this._statsWriter = undefined;
        } else {
            this._statsWriter = value;
        }
    }

    private async _collectWithoutStats(): Promise<void> {
        this._statsWriter?.updateSctpChannel({
            transportId: this._transportId,
            streamId: this._dataConsumer.id,
            channelId: this._dataConsumer.id,
            noReport: true,
            internal: this._internal,
        }, {});
    }

    public async collect(): Promise<void> {
        if (this._closed) {
            logger.warn(`Attempted to collect from a closed collector.`);
            return;
        }
        if (this._correspondCollector && this._correspondCollector.closed) {
            // if the corresponded collector is closed we need to close ourselves too
            this.close();
            return;
        }
        if (!this._statsWriter) {
            logger.debug(`No StatsWriter added to (${this.id})`)
            return;
        }
        if (this._config.pollStats === undefined || this._config.pollStats() === false) {
            return await this._collectWithoutStats();
        }
        const transportId = this._transportId;
        const polledStats = await this._dataConsumer.getStats();
        for (const stats of polledStats) {
            const sctpChannel: SfuSctpChannel = {
                transportId,
                noReport: false,
                streamId: this._dataConsumer.id,
                channelId: this._dataConsumer.id,
                label: stats.label,
                protocol: stats.protocol,
                internal: this._internal,
                // sctpSmoothedRoundTripTime: stats.sctpSmoothedRoundTripTime,
                // sctpCongestionWindow: stats.sctpCongestionWindow,
                // sctpReceiverWindow: stats.sctpReceiverWindow,
                // sctpMtu: stats.sctpMtu,
                // sctpUnackData: stats.sctpUnackData,
                // messageReceived: stats.messagesReceived,
                messageSent: stats.messagesSent,
                // bytesReceived: stats.bytesReceived,
                bytesSent: stats.bytesSent,
            };
            this._statsWriter?.updateSctpChannel(sctpChannel, this._config.appendix ?? {});
        }
    }
    public get closed(): boolean {
        return this._closed;
    }
    
    public close(): void {
        if (this._closed) {
            logger.info(`Attempted to close twice`);
            return;
        }
        this._closed = true;
        this._parent.remove(this.id);
    }
}