import { HlsM3u8File } from "../../ext-mod/emliri-es-libs/rialto/lib/hls-m3u8";
import { AdaptiveMedia, AdaptiveMediaPeriod } from '../../ext-mod/emliri-es-libs/rialto/lib/adaptive-media';
import { MediaSegment } from '../../ext-mod/emliri-es-libs/rialto/lib/media-segment';
import { AdaptiveMediaStreamConsumer } from '../../ext-mod/emliri-es-libs/rialto/lib/adaptive-media-client';
import { Scheduler } from '../../ext-mod/emliri-es-libs/objec-ts/lib/scheduler';

import {getLogger} from './re-logger';

import {TransmuxFlow} from './transmux-flow';
import { Packet } from "../../ext-mod/emliri-es-libs/multimedia.js/src/core/packet";

//import {HttpToMediaSourceFlow} from '../../ext-mod/emliri-es-libs/multimedia.js/src/flows/http-to-media-source.flow';

const SCHEDULER_FRAMERATE: number = 1;

const {log, debug} = getLogger("re-hls");

export class ReHls {

  private _scheduler: Scheduler = new Scheduler(SCHEDULER_FRAMERATE);
  private _mediaStreamConsumer: AdaptiveMediaStreamConsumer;

  private _mediaSource: MediaSource = new MediaSource();
  private _transmuxFlow: TransmuxFlow = null;

  private _isShutdown: boolean = false;

  private _url: string = null;
  private _pendingSetUrl: boolean;

  constructor(private _media: HTMLMediaElement) {

    this._media.src = URL.createObjectURL(this._mediaSource);

    this._mediaSource.addEventListener('sourceopen', () => {
      this._transmuxFlow = new TransmuxFlow(".ts", this._mediaSource);

      if (this._pendingSetUrl) {
        this._onSetUrl();
      }
    });
  }

  shutdown() {
    this._isShutdown = true;

    // TODO
  }

  public setUrl(url: string) {

    this._url = url;
    if (!this._transmuxFlow) {
      this._pendingSetUrl = true;
    } else {
      this._onSetUrl();
    }
  }

  public getUrl(): string { return this._url; }

  private _onSetUrl() {
    this._pendingSetUrl = false;
    this._processM3u8File(this._url);
  }

  private _processM3u8File(url: string) {
    const m3u8 = new HlsM3u8File(url);

    m3u8.fetch().then(() => {
      m3u8.parse().then((adaptiveMediaPeriods: AdaptiveMediaPeriod[]) => {
            this._onAdaptiveMediaPeriodsParsed(url, adaptiveMediaPeriods);
        })
    });
  }

  private _onAdaptiveMediaPeriodsParsed(url: string, adaptiveMediaPeriods: AdaptiveMediaPeriod[]) {
      // may get the first media of the first set in this period
      const media: AdaptiveMedia = adaptiveMediaPeriods[0].getDefaultMedia();

      media.refresh().then((media: AdaptiveMedia) => {

          media.segments.forEach((segment: MediaSegment) => {

              // TODO: hook up network engine

              //const swarmId = this._getSwarmIdForVariantPlaylist(media.getUrl());
              //segment.setRequestMaker(this._createResourceRequestMaker(swarmId));
          })

          const consumer: AdaptiveMediaStreamConsumer =
              new AdaptiveMediaStreamConsumer(media, this._scheduler, (segment: MediaSegment) => {
                  this._onSegmentBuffered(segment);
              });

          this._mediaStreamConsumer = consumer;

          consumer.maxConcurrentFetchInit = Infinity;
          consumer.updateFetchTarget(5);
      })
  }

  _onSegmentBuffered(segment: MediaSegment): any {
    log('onSegmentBuffered')

    if (!this._transmuxFlow) {
      throw new Error('No TransmuxFlow existant');
    }

    Array.from(this._transmuxFlow.getExternalSockets())[0]
      .transfer(Packet.fromArrayBuffer(
        segment.buffer, segment.mimeType
      ));
  }
}
