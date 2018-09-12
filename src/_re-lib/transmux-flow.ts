import { MP4DemuxProcessor } from "../../ext-mod/emliri-es-libs/multimedia.js/src//processors/mp4-demux.processor";
import { MPEGTSDemuxProcessor } from "../../ext-mod/emliri-es-libs/multimedia.js/src//processors/mpeg-ts-demux.processor";
import { MP4MuxProcessor, MP4MuxProcessorSupportedCodecs } from "../../ext-mod/emliri-es-libs/multimedia.js/src//processors/mp4-mux.processor";
import { Flow, FlowState, FlowStateChangeCallback } from "../../ext-mod/emliri-es-libs/multimedia.js/src//core/flow";
import { Socket, OutputSocket, InputSocket } from '../../ext-mod/emliri-es-libs/multimedia.js/src//core/socket';
import { H264ParseProcessor } from "../../ext-mod/emliri-es-libs/multimedia.js/src//processors/h264-parse.processor";
import { HTML5MediaSourceBufferSocket } from "../../ext-mod/emliri-es-libs/multimedia.js/src//io-sockets/html5-media-source-buffer.socket";
import { ProcessorEvent, ProcessorEventData } from "../../ext-mod/emliri-es-libs/multimedia.js/src//core/processor";

export class TransmuxFlow extends Flow {

  private _inSocket: InputSocket;

  constructor(url: string, mediaSource: MediaSource) {

    super(
      (prevState, newState) => {
        console.log('previous state:', prevState, 'new state:', newState)
      },
      (reason) => {
        console.log('state change aborted. reason:', reason);
      }
    );

    const mp4DemuxProc = new MP4DemuxProcessor();
    const tsDemuxProc = new MPEGTSDemuxProcessor();
    const h264ParseProc = new H264ParseProcessor();
    const mp4MuxProc = new MP4MuxProcessor();

    const mediaSourceSocket: HTML5MediaSourceBufferSocket
      = new HTML5MediaSourceBufferSocket(mediaSource, 'video/mp4; codecs=avc1.4d401f');

    tsDemuxProc.on(ProcessorEvent.OUTPUT_SOCKET_CREATED, onDemuxOutputCreated);
    mp4DemuxProc.on(ProcessorEvent.OUTPUT_SOCKET_CREATED, onDemuxOutputCreated);

    mp4MuxProc.out[0].connect(mediaSourceSocket);

    if (url.endsWith('.ts')) { // FIXME use mime-type of response
      this._inSocket = tsDemuxProc.in[0];
    } else { // FIXME use mime-type of response
      this._inSocket = mp4DemuxProc.in[0];
    }

    this.add(mp4DemuxProc, tsDemuxProc, mp4MuxProc);

    function onDemuxOutputCreated(data: ProcessorEventData) {
      const demuxOutputSocket = <OutputSocket> data.socket;

      console.log('demuxer output created');

      let muxerInputSocket;

      if (data.processor === mp4DemuxProc) {

        muxerInputSocket = mp4MuxProc.addVideoTrack(
          MP4MuxProcessorSupportedCodecs.AVC,
          25, // fps
          768, 576, // resolution
          60 // duration
        );


      } else if (data.processor === tsDemuxProc) {

        muxerInputSocket = mp4MuxProc.addVideoTrack(
          MP4MuxProcessorSupportedCodecs.AVC,
          60, // fps
          1280, 720, // resolution
          10 // duration
        );
      }

      demuxOutputSocket.connect(h264ParseProc.in[0]);
      h264ParseProc.out[0].connect(muxerInputSocket);
    }
  }

  /**
   * @override
   */
  getExternalSockets(): Set<Socket> {
    return new Set([this._inSocket]);
  }

  protected onVoidToWaiting_(cb: FlowStateChangeCallback) {}

  protected onWaitingToVoid_(cb: FlowStateChangeCallback) {}

  protected onWaitingToFlowing_(cb: FlowStateChangeCallback) {}

  protected onFlowingToWaiting_(cb: FlowStateChangeCallback) {}

  protected onStateChangeAborted_(reason: string) {}
}
