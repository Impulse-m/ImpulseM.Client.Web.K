/*
 * Originally from:
 * https://github.com/evgeny-nadymov/telegram-react
 * Copyright (C) 2018 Evgeny Nadymov
 * https://github.com/evgeny-nadymov/telegram-react/blob/master/LICENSE
 */

import EventListenerBase from '@helpers/eventListenerBase';
import {logger} from '@lib/logger';
import {GROUP_CALL_AMPLITUDE_ANALYSE_COUNT_MAX} from '@lib/calls/constants';
import stopTrack from '@lib/calls/helpers/stopTrack';
import {getAmplitude} from '@lib/calls/utils';

export async function waitForMediaTrackReplacements(replacements: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(replacements);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if(rejected) throw rejected.reason;
}

export type StreamItemBase = {
  type: 'input' | 'output',
  track: MediaStreamTrack,
  source: string,
  stream: MediaStream
};

export type StreamItem = StreamAudioItem | StreamVideoItem;

export type StreamAudioItem = StreamItemBase & {kind: 'audio', streamAnalyser: AudioStreamAnalyser};
export type StreamVideoItem = StreamItemBase & {kind: 'video'};

export type StreamAmplitude = {
  type: 'input' | 'output';
  source: string;
  stream: MediaStream;
  track: MediaStreamTrack;
  value: number;
};

class AudioStreamAnalyser {
  public analyser: AnalyserNode;
  public gain: GainNode;
  public streamSource: MediaStreamAudioSourceNode;

  constructor(context: AudioContext, stream: MediaStream) {
    const streamSource = this.streamSource = context.createMediaStreamSource(stream);
    const analyser = this.analyser = context.createAnalyser();
    const gain = this.gain = context.createGain();
    // const streamDestination = context.createMediaStreamDestination();

    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;
    analyser.smoothingTimeConstant = 0.05;
    analyser.fftSize = 1024;

    // connect Web Audio API
    streamSource.connect(analyser);
    // analyser.connect(context.destination);
  }

  public disconnect() {
    this.streamSource.disconnect();
    this.analyser.disconnect();
  }
}

export default class StreamManager {
  public static ANALYSER_LISTENER = new EventListenerBase<{amplitude: (details: {amplitudes: StreamAmplitude[], type: 'all' | 'input'}) => void}>();
  private context: AudioContext;
  public inputStream: MediaStream;

  private timer: number;
  private isContextClosing = false;
  private counter: number;

  private items: StreamItem[];

  private log: ReturnType<typeof logger>;


  constructor(private interval?: number) {
    this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.items = [];
    this.inputStream = new MediaStream();
    this.counter = 0;
    this.log = logger('SM');
  }

  public addStream(stream: MediaStream, type: StreamItem['type']) {
    stream.getTracks().forEach((track) => {
      this.addTrack(stream, track, type);
    });
  }

  /**
   * An output track names its participant/endpoint through `source`; an input track is keyed by the
   * stream's own `source` / id.
   */
  public addTrack(stream: MediaStream, track: MediaStreamTrack, type: StreamItem['type'], source?: string) {
    this.log('addTrack', type, track, stream);

    const {context, items, inputStream} = this;
    const kind: StreamItem['kind'] = track.kind as any;
    if(type === 'output' && !source) {
      throw new Error('StreamManager.addTrack: an output track needs an explicit source');
    }

    source = type === 'input' ? StreamManager.getInputSource(stream) : source;

    // this.removeTrack(track);
    switch(type) {
      case 'input': {
        if(!inputStream) {
          this.inputStream = stream;
        } else {
          inputStream.addTrack(track);
        }

        break;
      }

      case 'output': {
        for(let i = 0; i < items.length; ++i) {
          const {track: t, type, source: itemSource} = items[i];
          if(itemSource === source && type === 'input') {
            this.discardItem(i);
            break;
          }
        }

        break;
      }
    }

    // A stopped manager has closed its context; a source node cannot be created
    // on a closed one. The amplitude reader tolerates a missing analyser.
    const canAnalyse = kind === 'audio' && context.state !== 'closed';
    this.finalizeAddingTrack({
      type,
      source,
      stream,
      track,
      kind,
      streamAnalyser: canAnalyse ? new AudioStreamAnalyser(context, stream) : undefined
    });

    if(kind === 'audio' && this.interval) {
      this.changeTimer();
    }
  }

  private finalizeAddingTrack(item: StreamItem) {
    const {track} = item;
    track.addEventListener('ended', () => {
      this.removeTrack(track);
    }, {once: true});

    this.items.push(item);
  }

  // Drops an item and releases its Web Audio nodes. A source node keeps the
  // context graph (and the track it reads) referenced until it is disconnected.
  private discardItem(index: number) {
    const [item] = this.items.splice(index, 1);
    if(item.kind === 'audio') {
      item.streamAnalyser?.disconnect();
    }
  }

  public hasInputTrackKind(kind: StreamItem['kind']) {
    return this.items.find((item) => item.type === 'input' && item.kind === kind);
  }

  public static getInputSource(stream: MediaStream): string {
    return stream.source || stream.id;
  }

  public removeTrack(track: MediaStreamTrack) {
    this.log('removeTrack', track);

    const {items} = this;

    let handled = false;
    for(let i = 0, length = items.length; !handled && i < length; ++i) {
      const {track: t, type} = items[i];
      switch(type) {
        case 'output': {
          if(t === track) {
            this.discardItem(i);
            handled = true;
          }

          break;
        }

        case 'input': {
          if(t === track) {
            this.discardItem(i);
            this.inputStream.removeTrack(track);
            handled = true;
          }

          break;
        }
      }
    }

    if(track.kind === 'audio' && this.interval) {
      this.changeTimer();
    }
  }

  public replaceInputAudio(stream: MediaStream, oldTrack: MediaStreamTrack) {
    this.removeTrack(oldTrack);
    this.addStream(stream, 'input');
  }

  private changeTimer() {
    if(this.timer !== undefined) {
      clearInterval(this.timer);
    }

    if(this.items.length) {
      this.timer = window.setInterval(this.analyse, this.interval);
    }
  }

  public getAmplitude = (item: StreamAudioItem): StreamAmplitude => {
    const {streamAnalyser, stream, track, source, type} = item;
    const analyser = streamAnalyser?.analyser;
    if(!analyser) return;

    const array = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(array);
    const value = getAmplitude(array);

    return {
      type,
      source,
      stream,
      track,
      value
    };
  };

  public analyse = () => {
    const all = this.counter % 3 === 0;
    const filteredItems = all ? this.items : this.items.filter((x) => x.type === 'input');
    const audioItems = filteredItems.filter((x) => x.kind === 'audio') as StreamAudioItem[];
    const amplitudes = audioItems.slice(0, GROUP_CALL_AMPLITUDE_ANALYSE_COUNT_MAX).map(this.getAmplitude);
    if(++this.counter >= 1000) {
      this.counter = 0;
    }

    StreamManager.ANALYSER_LISTENER.dispatchEvent('amplitude', {
      amplitudes,
      type: all ? 'all' : 'input'
    });
  };

  /* public appendToConnection(connection: RTCPeerConnection) {
    if(this.inputStream) {
      this.inputStream.getTracks().forEach((track) => {
        connection.log('addTrack', track);
        connection.addTrack(track, this.inputStream);

        if(track.kind === 'video') {
          track.enabled = true;
        }
      });
    }
  } */

  public stop() {
    try {
      const tracks = this.inputStream.getTracks();
      tracks.forEach((track) => {
        stopTrack(track);
      });
    } catch(e) {
      this.log.error(e);
    }

    // stopTrack's synthetic `ended` removed the listed tracks above; sweep the
    // rest (remote tracks are owned by their media elements) so no analyser stays
    // wired, then stop the timer that would read them.
    while(this.items.length) {
      this.discardItem(this.items.length - 1);
    }
    if(this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // Every StreamManager owns an AudioContext and only the tracks were ever
    // stopped, so each call (and every camera/screen connection within it)
    // leaked a running context — an audio thread per leftover manager. Close
    // it; `state` and `close` are guarded for environments without Web Audio.
    //
    // Once only: a second stop() (hangUp and cleanup both reach it) would close a context that is
    // already closing, which Firefox rejects with InvalidStateError.
    const {context} = this;
    if(context && !this.isContextClosing && context.state !== 'closed' && typeof context.close === 'function') {
      this.isContextClosing = true;
      context.close().catch((err) => {
        this.log.error('closing the audio context failed', err);
      });
    }
  }
}
