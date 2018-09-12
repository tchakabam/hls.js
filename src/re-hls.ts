import { HlsM3u8File } from "../ext-mod/emliri-es-libs/rialto/lib/hls-m3u8";
import { AdaptiveMedia, AdaptiveMediaPeriod } from '../ext-mod/emliri-es-libs/rialto/lib/adaptive-media';
import { MediaSegment } from '../ext-mod/emliri-es-libs/rialto/lib/media-segment';
import { AdaptiveMediaStreamConsumer } from '../ext-mod/emliri-es-libs/rialto/lib/adaptive-media-client';
import { Scheduler } from '../ext-mod/emliri-es-libs/objec-ts/lib/scheduler';
import { logger } from "./utils/logger";

const SCHEDULER_FRAMERATE: number = 1;

export class ReHls {
  private _scheduler: Scheduler = new Scheduler(SCHEDULER_FRAMERATE);
  private _mediaStreamConsumer: AdaptiveMediaStreamConsumer;

  public setUrl(url: string) {
    this._processM3u8File(url);
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
    logger.debug('onSegmentBuffered')
  }
}
