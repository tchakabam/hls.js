import { TaskScheduler } from "../task-scheduler";
import { Event } from '../events';
import { MediaTrack } from "./media-track";
import { AlternateMediaType } from "../hls";

export class AlternateMediaTracksHandler extends TaskScheduler {

  private _trackId: number;
  private _selectDefaultTrack: boolean;
  private _tracks: MediaTrack[];
  private _trackIdBlacklist: {[id: number]: boolean} = {};
  private _groupId: string;
  private _trackType: AlternateMediaType;

  constructor (hls, mediaType: AlternateMediaType) {
    super(hls,
      Event.MANIFEST_LOADING,
      Event.MANIFEST_PARSED);

      this._trackType = mediaType;
  }

  /**
   * Reset audio tracks on new manifest loading.
   */
  onManifestLoading () {
    this._tracks = [];
    this._trackId = -1;
    this._selectDefaultTrack = true;
  }

  /**
   * Store tracks data from manifest parsed data.
   *
   * Trigger AUDIO_TRACKS_UPDATED event.
   *
   * @param {*} data
   */
  onManifestParsed (data) {
    const tracks: MediaTrack[] = this._tracks = data.audioTracks || [];
    this.hls.trigger(Event.AUDIO_TRACKS_UPDATED, { audioTracks: tracks });
  }

  doTick() {
    throw new Error("Method not implemented.");
  }

}
