/*
 * jitter-buffer playback worklet (one instance per talkgroup channel).
 *
 * The main thread decodes Opus -> Float32 PCM (mono, 48 kHz) and posts each
 * chunk here. We queue chunks and feed the audio graph a steady stream,
 * pre-buffering ~`targetMs` to absorb network jitter. On underrun we output
 * silence and re-prebuffer; if the queue grows too large (a slow/paused tab
 * catching up) we drop the oldest audio so live audio stays live.
 */
class JitterPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sampleRate = o.sampleRate || sampleRate; // worklet global
    this.targetSamples = Math.round(
      ((o.targetMs || 150) / 1000) * this.sampleRate,
    );
    this.maxSamples = Math.round(((o.maxMs || 800) / 1000) * this.sampleRate);

    this.queue = []; // array of Float32Array
    this.head = 0; // read offset into queue[0]
    this.buffered = 0; // total samples queued (minus head)
    this.priming = true; // wait until targetSamples before playing

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.pcm) {
        this.queue.push(d.pcm);
        this.buffered += d.pcm.length;
        // Drop oldest if we've fallen too far behind (slow consumer).
        while (this.buffered > this.maxSamples && this.queue.length > 1) {
          const drop = this.queue.shift();
          this.buffered -= drop.length - this.head;
          this.head = 0;
        }
        if (this.priming && this.buffered >= this.targetSamples)
          this.priming = false;
      } else if (d && d.flush) {
        this.queue = [];
        this.head = 0;
        this.buffered = 0;
        this.priming = true;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    if (this.priming) {
      out.fill(0);
      return true;
    }

    for (let i = 0; i < out.length; i++) {
      if (this.queue.length === 0) {
        // underrun: emit silence and re-prime so we rebuild a cushion
        out.fill(0, i);
        this.priming = true;
        break;
      }
      const chunk = this.queue[0];
      out[i] = chunk[this.head++];
      this.buffered--;
      if (this.head >= chunk.length) {
        this.queue.shift();
        this.head = 0;
      }
    }
    return true;
  }
}

registerProcessor("jitter-player", JitterPlayer);
