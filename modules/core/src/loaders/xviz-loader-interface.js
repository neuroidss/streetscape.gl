// Copyright (c) 2019 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import {getXVIZConfig} from '@xviz/parser';
import {clamp} from 'math.gl';

import {getTimeSeries} from '../utils/metrics-helper';
import createSelector from '../utils/create-selector';
import stats from '../utils/stats';

/* eslint-disable callback-return */
export default class XVIZLoaderInterface {
  constructor(options = {}) {
    this.options = options;
    this._debug = options.debug || (() => {});
    this.callbacks = {};

    this.listeners = [];
    this.state = {};
    this._version = 0;
    this._updateTimer = null;
  }

  /* Event types:
   * - ready
   * - update
   * - finish
   * - error
   */
  on(eventType, cb) {
    this.callbacks[eventType] = this.callbacks[eventType] || [];
    this.callbacks[eventType].push(cb);
    return this;
  }

  off(eventType, cb) {
    const callbacks = this.callbacks[eventType];
    if (callbacks) {
      const index = callbacks.indexOf(cb);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    }
    return this;
  }

  emit(eventType, eventArgs) {
    const callbacks = this.callbacks[eventType];
    if (callbacks) {
      for (const cb of callbacks) {
        cb(eventType, eventArgs);
      }
    }
    stats.bump(`loader-${eventType}`);
  }

  subscribe(instance) {
    this.listeners.push(instance);
  }

  unsubscribe(instance) {
    const index = this.listeners.findIndex(o => o === instance);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  get(key) {
    return this.state[key];
  }

  set(key, value) {
    if (this.state[key] !== value) {
      this.state[key] = value;
      this._version++;
      if (!this._updateTimer) {
        /* global requestAnimationFrame */
        this._updateTimer = requestAnimationFrame(this._update);
      }
    }
  }

  /* Connection API */
  isOpen() {
    return false;
  }

  connect() {
    throw new Error('not implemented');
  }

  seek(timestamp) {
    const metadata = this.getMetadata();

    if (metadata) {
      const startTime = this.getLogStartTime();
      const endTime = this.getLogEndTime();
      if (Number.isFinite(startTime) && Number.isFinite(endTime)) {
        timestamp = clamp(timestamp, startTime, endTime);
      }
    }

    this.set('timestamp', timestamp);
  }

  setLookAhead(lookAhead) {
    this.set('lookAhead', lookAhead);
  }

  updateStreamSettings(settings) {
    const streamSettings = this.get('streamSettings');
    this.set('streamSettings', {...streamSettings, ...settings});
  }

  close() {
    throw new Error('not implemented');
  }

  /* Data selector API */

  getCurrentTime = () => this.get('timestamp');

  getLookAhead = () => this.get('lookAhead');

  getMetadata = () => this.get('metadata');

  getStreamSettings = () => this.get('streamSettings');

  getLogSynchronizer = () => this.get('logSynchronizer');

  _getStreams = () => this.get('streams');

  getStreams = createSelector(
    this,
    [this.getStreamSettings, this._getStreams],
    (streamSettings, streams) => {
      if (!streamSettings || !streams) {
        return streams;
      }
      const result = {};
      for (const streamName in streams) {
        if (streamSettings[streamName]) {
          result[streamName] = streams[streamName];
        }
      }
      return result;
    }
  );

  getBufferRange() {
    throw new Error('not implemented');
  }

  getBufferStart() {
    return this.getLogStartTime();
  }

  getBufferEnd() {
    return this.getLogEndTime();
  }

  getLogStartTime = createSelector(this, this.getMetadata, metadata => {
    return metadata && metadata.start_time && metadata.start_time + getXVIZConfig().TIME_WINDOW;
  });

  getLogEndTime = createSelector(this, this.getMetadata, metadata => {
    return metadata && metadata.end_time;
  });

  getCurrentFrame = createSelector(
    this,
    [
      this.getLogSynchronizer,
      this.getStreamSettings,
      this.getCurrentTime,
      this.getLookAhead,
      this.getStreams
    ],
    // `getStreams` is only needed to trigger recomputation.
    // The logSynchronizer has access to the streamBuffer.
    (logSynchronizer, streamSettings, timestamp, lookAhead) => {
      if (logSynchronizer && Number.isFinite(timestamp)) {
        logSynchronizer.setTime(timestamp);
        logSynchronizer.setLookAheadTimeOffset(lookAhead);
        return logSynchronizer.getCurrentFrame(streamSettings);
      }
      return null;
    }
  );

  // TODO add declare ui metadata
  getTimeSeries = createSelector(this, [this.getMetadata, this.getStreams], (metadata, streams) =>
    getTimeSeries({metadata, streams})
  );

  /* Private actions */
  _update = () => {
    this._updateTimer = null;
    this.listeners.forEach(o => o(this._version));
  };

  _setMetadata(metadata) {
    this.set('metadata', metadata);
    if (metadata.streams && Object.keys(metadata.streams).length > 0) {
      this.set('streamSettings', metadata.streams);
    }
    const timestamp = this.get('timestamp');
    const newTimestamp = Number.isFinite(timestamp) ? timestamp : metadata.start_time;
    if (Number.isFinite(newTimestamp)) {
      this.seek(newTimestamp);
    }
  }
}
