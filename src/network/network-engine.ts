import { logger } from '../utils/logger';
import { MediaVariantDetails, HlsConfig } from '../hls';
import { MediaFragment } from '../m3u8/media-fragment';

const { performance } = window;

export enum NetworkEngineContextType {
  MANIFEST = 'manifest',
  LEVEL = 'level',
  AUDIO_TRACK = 'audioTrack',
  SUBTITLE_TRACK = 'subtitleTrack',
  MEDIA_FRAGMENT = 'mediaFragment',
  KEY = 'key'
};

type ContextType = NetworkEngineContextType;

export type NetworkEngineContext = {
  id: number,
  loader: NetworkEngine,
  type: ContextType
  url: string,
  responseType: XMLHttpRequestResponseType,
  level: number,
  levelDetails: MediaVariantDetails,
  isSidxRequest?: boolean,
  rangeStart?: number,
  rangeEnd?: number,
  frag?: MediaFragment
}

export type NetworkEngineContextMap = (Partial<{[contextType in NetworkEngineContextType]: NetworkEngine}>);

export type Context = NetworkEngineContext;

export type NetworkEngineLoadOptions = {
  timeout: number
  retryDelay: number,
  maxRetryDelay: number,
  maxRetry: number
}

export type NetworkEngineLoadStats = {
  aborted?: boolean,
  trequest: number,
  tfirst?: number,
  tload?: number,
  retry: number, // no of retries
  loaded?: number // bytes
  total?: number
}

export type NetworkEngineSetupFn = (xhr: XMLHttpRequest, url: string) => void;

export type NetworkEngingResponse = {
  url: string,
  data: ArrayBuffer | string
}

export type NetworkEngineProgressCb = (
  stats: NetworkEngineLoadStats,
  context: NetworkEngineContext,
  xhr: XMLHttpRequest) => void

export type NetworkEngineTimeoutCb = (
  stats: NetworkEngineLoadStats,
  context: NetworkEngineContext,
  xhr: XMLHttpRequest) => void

export type NetworkEngineErrorCb = (
  error: {code: number, text: string},
  context: NetworkEngineContext,
  xhr: XMLHttpRequest) => void

export type NetworkEngineSuccessCb = (
  response: NetworkEngingResponse,
  stats: NetworkEngineLoadStats,
  context: NetworkEngineContext,
  xhr: XMLHttpRequest) => void

export type NetworkEngineCallbacks = {
  onProgress?: NetworkEngineProgressCb,
  onSuccess: NetworkEngineSuccessCb,
  onTimeout: NetworkEngineTimeoutCb,
  onError: NetworkEngineErrorCb
}

export class NetworkEngine {

  private _xhr: XMLHttpRequest;
  private _requestTimeout: number;
  private _retryTimeout: number;
  private _callbacks: NetworkEngineCallbacks;
  private _retryDelay: number;
  private _config: NetworkEngineLoadOptions;

  private _stats: NetworkEngineLoadStats;
  private _context: NetworkEngineContext;

  private _xhrSetup: NetworkEngineSetupFn;

  constructor (config: HlsConfig) {
    if (config && config.xhrSetup) {
      this._xhrSetup = config.xhrSetup;
    }
  }

  destroy () {
    this.abort();
    this._xhr = null;
  }

  abort () {
    let xhr = this._xhr;
    if (xhr && xhr.readyState !== 4) {
      this._stats.aborted = true;
      xhr.abort();
    }

    window.clearTimeout(this._requestTimeout);
    this._requestTimeout = null;
    window.clearTimeout(this._retryTimeout);
    this._retryTimeout = null;
  }

  load (context: NetworkEngineContext, config: NetworkEngineLoadOptions, callbacks: NetworkEngineCallbacks) {
    this._context = context;
    this._config = config;
    this._callbacks = callbacks;
    this._stats = { trequest: performance.now(), retry: 0 };
    this._retryDelay = config.retryDelay;
    this._execRequest();
  }

  get context(): NetworkEngineContext {
    return this._context;
  }

  private _execRequest () {

    if (this._xhr) {
      throw new Error('Request already ongoing');
    }

    const xhr = this._xhr = new XMLHttpRequest();
    const context = this._context;
    const xhrSetup = this._xhrSetup;
    const stats = this._stats;

    stats.tfirst = 0;
    stats.loaded = 0;

    try {
      if (xhrSetup) {
        try {
          xhrSetup(xhr, context.url);
        } catch (e) {
          // fix xhrSetup: (xhr, url) => {xhr.setRequestHeader("Content-Language", "test");}
          // not working, as xhr.setRequestHeader expects xhr.readyState === OPEN
          xhr.open('GET', context.url, true);
          xhrSetup(xhr, context.url);
        }
      }
      if (!xhr.readyState) {
        xhr.open('GET', context.url, true);
      }
    } catch (e) {
      // IE11 throws an exception on xhr.open if attempting to access an HTTP resource over HTTPS
      this._callbacks.onError({ code: xhr.status, text: e.message }, context, xhr);
      return;
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader('Range', 'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1));
    }

    xhr.onreadystatechange = this._handleReadyStateChange.bind(this);
    xhr.onprogress = this._handleProgress.bind(this);
    xhr.responseType = context.responseType;

    // setup timeout before we perform request
    this._requestTimeout = window.setTimeout(this._handleTimeout.bind(this), this._config.timeout);
    xhr.send();
  }

  private _handleReadyStateChange (event: Event) {
    let xhr: XMLHttpRequest = <XMLHttpRequest> event.currentTarget,
      readyState = xhr.readyState,
      stats = this._stats,
      context = this._context,
      config = this._config;

    // don't proceed if xhr has been aborted
    if (stats.aborted) {
      return;
    }

    // >= HEADERS_RECEIVED
    if (readyState >= 2) {
      // clear xhr timeout and rearm it if readyState less than 4
      window.clearTimeout(this._requestTimeout);
      if (stats.tfirst === 0) {
        stats.tfirst = Math.max(performance.now(), stats.trequest);
      }

      if (readyState === 4) {
        let status = xhr.status;
        // http status between 200 to 299 are all successful
        if (status >= 200 && status < 300) {
          stats.tload = Math.max(stats.tfirst, performance.now());
          let data,
              len;
          if (context.responseType === 'arraybuffer') {
            data = <ArrayBuffer> xhr.response;
            len = data.byteLength;
          } else {
            data = <string> xhr.responseText;
            len = data.length;
          }
          stats.loaded = stats.total = len;
          const response = {
            url: xhr.responseURL,
            data
          };
          this._callbacks.onSuccess(response, stats, context, xhr);
        } else {
          // if max nb of retries reached or if http status between 400 and 499 (such error cannot be recovered, retrying is useless), return error
          if (stats.retry >= config.maxRetry || (status >= 400 && status < 499)) {
            logger.error(`${status} while loading ${context.url}`);
            this._callbacks.onError({ code: status, text: xhr.statusText }, context, xhr);
          } else {
            // retry
            logger.warn(`${status} while loading ${context.url}, retrying in ${this._retryDelay}...`);
            // aborts and resets internal state
            this.destroy();
            // schedule retry
            this._retryTimeout = window.setTimeout(this._execRequest.bind(this), this._retryDelay);
            // set exponential backoff
            this._retryDelay = Math.min(2 * this._retryDelay, config.maxRetryDelay);
            stats.retry++;
          }
        }
      } else {
        // readyState >= 2 AND readyState !==4 (readyState = HEADERS_RECEIVED || LOADING) rearm timeout as xhr not finished yet
        this._requestTimeout = window.setTimeout(this._handleTimeout.bind(this), config.timeout);
      }
    }
  }

  private _handleTimeout () {
    logger.warn(`timeout while loading ${this._context.url}`);
    this._callbacks.onTimeout(this._stats, this._context, null);
  }

  private _handleProgress (event) {
    let xhr = event.currentTarget,
      stats = this._stats;

    stats.loaded = event.loaded;
    if (event.lengthComputable) {
      stats.total = event.total;
    }

    let onProgress: NetworkEngineProgressCb = this._callbacks.onProgress;
    if (onProgress) {
      // third arg is to provide on progress data
      onProgress(stats, this._context, xhr);
    }
  }
}
