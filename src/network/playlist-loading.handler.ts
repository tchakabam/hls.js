/**
 * PlaylistLoader - delegate for media manifest/playlist loading tasks. Takes care of parsing media to internal data-models.
 *
 * Once loaded, dispatches events with parsed data-models of manifest/levels/audio/subtitle tracks.
 *
 * Uses loader(s) set in config to do actual internal loading of resource tasks.
 *
 * @module
 *
 */

import { Event } from '../events';
import { EventHandler } from '../event-handler';
import { ErrorType, ErrorDetail } from '../errors';

import { logger } from '../utils/logger';

import MP4Demuxer from '../transmux/demux/mp4demuxer';
import { M3U8Parser } from '../m3u8/m3u8-parser';
import { NetworkEngine } from './network-engine';
import { AlternateMediaType, QualityLevel, MediaVariantDetails } from '../hls';
import { createTrackListsFromM3u8 } from '../track-controller/media-track';
import { createVariantFromM3u8 } from '../m3u8/media-variant';

const { performance } = window;

/**
 * `type` property values for this loaders' context object
 * @enum
 *
 */
enum ContextType {
  MANIFEST = 'manifest',
  LEVEL = 'level',
  AUDIO_TRACK = 'audioTrack',
  SUBTITLE_TRACK = 'subtitleTrack'
};

type Context = {
  id: number,
  loader: NetworkEngine,
  level: number
  type: ContextType
  url: string,
  levelDetails: MediaVariantDetails,
  responseType: string
  isSidxRequest?: boolean,
  rangeStart?: 0,
  rangeEnd?: 2048,
}

/**
 * @enum {string}
 */
enum LevelType {
  MAIN = 'main',
  AUDIO = 'audio',
  SUBTITLE = 'subtitle'
};

/**
 * @constructor
 */
export class PlaylistLoadingHandler extends EventHandler {

  private loaders: Partial<{[contextType in ContextType]: NetworkEngine}>;

  /**
   * @constructs
   * @param {Hls} hls
   */
  constructor (hls) {
    super(hls,
      Event.MANIFEST_LOADING,
      Event.LEVEL_LOADING,
      Event.AUDIO_TRACK_LOADING,
      Event.SUBTITLE_TRACK_LOADING);

    this.loaders = {};
  }

  static get ContextType (): typeof ContextType {
    return ContextType;
  }

  static get LevelType (): typeof LevelType {
    return LevelType;
  }

  /**
   * @param {ContextType} type
   * @returns {boolean}
   */
  static canHaveQualityLevels (type: ContextType) {
    return (type !== ContextType.AUDIO_TRACK &&
      type !== ContextType.SUBTITLE_TRACK);
  }

  /**
   * Map context.type to LevelType
   * @param {ContextType} context
   * @returns {LevelType}
   */
  static mapContextToLevelType (context: Context) {
    const { type } = context;

    switch (type) {
    case ContextType.AUDIO_TRACK:
      return LevelType.AUDIO;
    case ContextType.SUBTITLE_TRACK:
      return LevelType.SUBTITLE;
    default:
      return LevelType.MAIN;
    }
  }

  static getResponseUrl (response, context: Context) {
    let url = response.url;
    // responseURL not supported on some browsers (it is used to detect URL redirection)
    // data-uri mode also not supported (but no need to detect redirection)
    if (url === undefined || url.indexOf('data:') === 0) {
      // fallback to initial URL
      url = context.url;
    }
    return url;
  }

  /**
   * Returns defaults or configured loader-type overloads (pLoader and loader config params)
   * Default loader is XHRLoader (see utils)
   * @param {object} context
   * @returns {*} or other compatible configured overload
   */
  createInternalLoader (context: Context): NetworkEngine {
    const config = this.hls.config;
    const loader = new NetworkEngine(config);

    context.loader = loader;
    this.loaders[context.type] = loader;

    return loader;
  }

  getInternalLoader (context: Context): NetworkEngine {
    return this.loaders[context.type];
  }

  resetInternalLoader (contextType: ContextType) {
    if (this.loaders[contextType]) {
      delete this.loaders[contextType];
    }
  }

  /**
   * Call `destroy` on all internal loader instances mapped (one per context type)
   */
  destroyInternalLoaders () {
    for (let contextType in this.loaders) {
      let loader = this.loaders[contextType];
      if (loader) {
        loader.destroy();
      }

      this.resetInternalLoader(<ContextType> contextType);
    }
  }

  destroy () {
    this.destroyInternalLoaders();

    super.destroy();
  }

  onManifestLoading (data) {
    this.load(data.url, {
      type: ContextType.MANIFEST,
      level: 0,
      id: null,
      url: null,
      loader: null,
      levelDetails: null,
      responseType: null
    });
  }

  onLevelLoading (data) {
    this.load(data.url, { type: ContextType.LEVEL, level: data.level, id: data.id, url: null, loader: null, levelDetails: null,
      responseType: null  });
  }

  onAudioTrackLoading (data) {
    this.load(data.url, { type: ContextType.AUDIO_TRACK, level: null, id: data.id, url: null, loader: null, levelDetails: null,
      responseType: null  });
  }

  onSubtitleTrackLoading (data) {
    this.load(data.url, { type: ContextType.SUBTITLE_TRACK, level: null, id: data.id, url: null, loader: null, levelDetails: null,
      responseType: null  });
  }

  load (url: string, context: Context) {
    const config = this.hls.config;

    logger.debug(`Loading playlist of type ${context.type}, level: ${context.level}, id: ${context.id}`);

    // Check if a loader for this context already exists
    let loader = this.getInternalLoader(context);
    if (loader) {
      const loaderContext = loader.context;
      if (loaderContext && loaderContext.url === url) { // same URL can't overlap
        logger.trace('playlist request ongoing');
        return false;
      } else {
        logger.warn(`aborting previous loader for type: ${context.type}`);
        loader.abort();
      }
    }

    let maxRetry,
        timeout,
        retryDelay,
        maxRetryDelay;

    // apply different configs for retries depending on
    // context (manifest, level, audio/subs playlist)
    switch (context.type) {
    case ContextType.MANIFEST:
      maxRetry = config.manifestLoadingMaxRetry;
      timeout = config.manifestLoadingTimeOut;
      retryDelay = config.manifestLoadingRetryDelay;
      maxRetryDelay = config.manifestLoadingMaxRetryTimeout;
      break;
    case ContextType.LEVEL:
      // Disable internal loader retry logic, since we are managing retries in Level Controller
      maxRetry = 0;
      timeout = config.levelLoadingTimeOut;
      // TODO Introduce retry settings for audio-track and subtitle-track, it should not use level retry config
      break;
    default:
      maxRetry = config.levelLoadingMaxRetry;
      timeout = config.levelLoadingTimeOut;
      retryDelay = config.levelLoadingRetryDelay;
      maxRetryDelay = config.levelLoadingMaxRetryTimeout;
      break;
    }

    loader = this.createInternalLoader(context);

    context.url = url;
    context.responseType = context.responseType || ''; // FIXME: (should not be necessary to do this)

    const loaderConfig = {
      timeout,
      maxRetry,
      retryDelay,
      maxRetryDelay
    };

    const loaderCallbacks = {
      onSuccess: this.loadsuccess.bind(this),
      onError: this.loaderror.bind(this),
      onTimeout: this.loadtimeout.bind(this)
    };

    logger.debug(`Calling internal loader delegate for URL: ${url}`);

    loader.load(context, loaderConfig, loaderCallbacks);

    return true;
  }

  loadsuccess (response, stats, context: Context, networkDetails = null) {
    if (context.isSidxRequest) {
      this._handleSidxRequest(response, context);
      this._handlePlaylistLoaded(response, stats, context, networkDetails);
      return;
    }

    this.resetInternalLoader(context.type);

    const string = response.data;

    stats.tload = performance.now();
    // stats.mtime = new Date(target.getResponseHeader('Last-Modified'));

    // Validate if it is an M3U8 at all
    if (string.indexOf('#EXTM3U') !== 0) {
      this._handleManifestParsingError(response, context, 'no EXTM3U delimiter', networkDetails);
      return;
    }

    // Check if chunk-list or master. handle empty chunk list case (first EXTINF not signaled, but TARGETDURATION present)
    if (string.indexOf('#EXTINF:') > 0 || string.indexOf('#EXT-X-TARGETDURATION:') > 0) {
      this._handleTrackOrLevelPlaylist(response, stats, context, networkDetails);
    } else {
      this._handleMasterPlaylist(response, stats, context, networkDetails);
    }
  }

  loaderror (response, context: Context, networkDetails = null) {
    this._handleNetworkError(context, networkDetails);
  }

  loadtimeout (stats, context: Context, networkDetails = null) {
    this._handleNetworkError(context, networkDetails, true);
  }

  _handleMasterPlaylist (response, stats, context: Context, networkDetails) {
    const hls = this.hls;
    const data = response.data;

    const url = PlaylistLoadingHandler.getResponseUrl(response, context);

    const levels: QualityLevel[] = M3U8Parser.parseMasterPlaylist(data, url);
    if (!levels.length) {
      this._handleManifestParsingError(response, context, 'no level found in manifest', networkDetails);
      return;
    }

    const trackSet = createTrackListsFromM3u8(data, url, levels);

    hls.trigger(Event.MANIFEST_LOADED, {
      levels,
      audioTracks: trackSet.AUDIO,
      subtitleTracks: trackSet.SUBTITLES,
      url,
      stats,
      networkDetails
    });
  }

  _handleTrackOrLevelPlaylist (response, stats, context: Context, networkDetails) {
    const hls = this.hls;

    const { id, level, type } = context;

    const url = PlaylistLoadingHandler.getResponseUrl(response, context);

    const levelUrlId = Number.isFinite(id) ? id : 0;
    const levelId = Number.isFinite(level) ? level : levelUrlId;
    const levelType = PlaylistLoadingHandler.mapContextToLevelType(context);

    const levelDetails = createVariantFromM3u8(response.data, url, levelId, levelType, levelUrlId);

    // save parsing time
    stats.tparsed = performance.now();

    // set loading stats on level structure
    levelDetails.tload = stats.tload;

    // We have done our first request (Manifest-type) and receive
    // not a master playlist but a chunk-list (track/level)
    // We fire the manifest-loaded event anyway with the parsed level-details
    // by creating a single-level structure for it.
    if (type === ContextType.MANIFEST) {
      const singleLevel = {
        url,
        details: levelDetails
      };

      hls.trigger(Event.MANIFEST_LOADED, {
        levels: [singleLevel],
        audioTracks: [],
        subtitleTracks: [],
        url,
        stats,
        networkDetails
      });
    }

    // in case we need SIDX ranges
    // return early after calling load for
    // the SIDX box.
    if (levelDetails.needSidxRanges) {
      const sidxUrl = levelDetails.initSegment.url;
      this.load(sidxUrl, {
        isSidxRequest: true,
        type,
        level,
        levelDetails,
        id,
        rangeStart: 0,
        rangeEnd: 2048,
        loader: null,
        url: null,
        responseType: 'arraybuffer'
      });
      return;
    }

    // extend the context with the new levelDetails property
    context.levelDetails = levelDetails;

    this._handlePlaylistLoaded(response, stats, context, networkDetails);
  }

  _handleSidxRequest (response, context: Context) {
    const sidxInfo = MP4Demuxer.parseSegmentIndex(new Uint8Array(response.data));
    sidxInfo.references.forEach((segmentRef, index) => {
      const segRefInfo = segmentRef.info;
      const frag = context.levelDetails.fragments[index];

      if (!frag.byteRange) {
        frag.rawByteRange = String(1 + segRefInfo.end - segRefInfo.start) + '@' + String(segRefInfo.start);
      }
    });

    context.levelDetails.initSegment.rawByteRange = String(sidxInfo.moovEndOffset) + '@0';
  }

  _handleManifestParsingError (response, context, reason, networkDetails) {
    this.hls.trigger(Event.ERROR, {
      type: ErrorType.NETWORK_ERROR,
      details: ErrorDetail.MANIFEST_PARSING_ERROR,
      fatal: true,
      url: response.url,
      reason,
      networkDetails
    });
  }

  _handleNetworkError (context, networkDetails, timeout = false) {
    logger.info(`A network error occured while loading a ${context.type}-type playlist`);

    let details;
    let fatal;

    const loader = this.getInternalLoader(context);

    switch (context.type) {
    case ContextType.MANIFEST:
      details = (timeout ? ErrorDetail.MANIFEST_LOAD_TIMEOUT : ErrorDetail.MANIFEST_LOAD_ERROR);
      fatal = true;
      break;
    case ContextType.LEVEL:
      details = (timeout ? ErrorDetail.LEVEL_LOAD_TIMEOUT : ErrorDetail.LEVEL_LOAD_ERROR);
      fatal = false;
      break;
    case ContextType.AUDIO_TRACK:
      details = (timeout ? ErrorDetail.AUDIO_TRACK_LOAD_TIMEOUT : ErrorDetail.AUDIO_TRACK_LOAD_ERROR);
      fatal = false;
      break;
    default:
      // details = ...?
      fatal = false;
    }

    if (loader) {
      loader.abort();
      this.resetInternalLoader(context.type);
    }

    this.hls.trigger(Event.ERROR, {
      type: ErrorType.NETWORK_ERROR,
      details,
      fatal,
      url: loader.context.url,
      loader,
      context,
      networkDetails
    });
  }

  _handlePlaylistLoaded (response, stats, context, networkDetails) {
    const { type, level, id, levelDetails } = context;

    if (!levelDetails.targetduration) {
      this._handleManifestParsingError(response, context, 'invalid target duration', networkDetails);
      return;
    }

    const canHaveLevels = PlaylistLoadingHandler.canHaveQualityLevels(context.type);
    if (canHaveLevels) {
      this.hls.trigger(Event.LEVEL_LOADED, {
        details: levelDetails,
        level: level || 0,
        id: id || 0,
        stats,
        networkDetails
      });
    } else {
      switch (type) {
      case ContextType.AUDIO_TRACK:
        this.hls.trigger(Event.AUDIO_TRACK_LOADED, {
          details: levelDetails,
          id,
          stats,
          networkDetails
        });
        break;
      case ContextType.SUBTITLE_TRACK:
        this.hls.trigger(Event.SUBTITLE_TRACK_LOADED, {
          details: levelDetails,
          id,
          stats,
          networkDetails
        });
        break;
      }
    }
  }
}
