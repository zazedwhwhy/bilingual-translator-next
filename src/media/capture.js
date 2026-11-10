// Each recorder produces a complete WebM container. At a boundary the next
// recorder starts before the previous one stops; decoding/storage run afterward.
export class TabRecorder {
  constructor({ sample, save, onStop }) {
    Object.assign(this, { sample, save, onStop });
    this.active = false;
    this.completed = 0;
    this.pending = new Set();
  }
  async start(stream, { chunkMs = 15000 } = {}) {
    this.stream = stream;
    this.chunkMs = chunkMs;
    try {
      if (!stream.getAudioTracks().length)
        throw Object.assign(Error("标签页没有音频轨道"), {
          code: "AUDIO_INVALID",
        });
      this.audio = new AudioContext();
      this.source = this.audio.createMediaStreamSource(stream);
      this.source.connect(this.audio.destination);
      await this.audio.resume();
      for (const track of stream.getTracks())
        track.addEventListener(
          "ended",
          () => void this.stop("音频轨道已结束", true).catch(() => {}),
          { once: true },
        );
      this.active = true;
      this.started = performance.now();
      await this.beginChunk();
      return this.status();
    } catch (error) {
      await this.stop(error.message, true, error);
      throw error;
    }
  }
  async beginChunk() {
    if (!this.active) return;
    const snapshot = await this.sample();
    if (!this.active) return;
    const clock = performance.timeOrigin + performance.now(),
      lag = (clock - snapshot.clock) / 1000;
    if (
      snapshot.paused ||
      snapshot.seeking ||
      snapshot.rate !== 1 ||
      !Number.isFinite(snapshot.time) ||
      lag < -0.05 ||
      lag > 0.5
    )
      throw Object.assign(
        Error("视频时钟不连续，请保持1倍速播放并重新录制。"),
        { code: "CAPTURE_TIMELINE_CHANGED" },
      );
    const row = {
      offset: snapshot.time + Math.max(0, lag),
      parts: [],
      discard: false,
    };
    row.recorder = new MediaRecorder(this.stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 64000,
    });
    row.recorder.ondataavailable = (event) => {
      if (event.data.size) row.parts.push(event.data);
    };
    row.recorder.onerror = (event) => {
      row.error = event.error || Error("录音失败");
    };
    row.done = new Promise((resolve, reject) => {
      row.recorder.onstop = async () => {
        try {
          if (row.error) throw row.error;
          const blob = new Blob(row.parts, { type: row.recorder.mimeType });
          row.parts = [];
          if (!row.discard && blob.size) {
            const decoded = await this.audio.decodeAudioData(
              await blob.arrayBuffer(),
            );
            if (decoded.duration >= 0.3) {
              await this.save(blob, {
                offset: row.offset,
                duration: decoded.duration,
              });
              this.completed++;
            }
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      };
    });
    this.pending.add(row.done);
    row.done.then(
      () => this.pending.delete(row.done),
      (error) => {
        this.pending.delete(row.done);
        void this.stop(error.message, true, error).catch(() => {});
      },
    );
    row.recorder.start();
    const previous = this.chunk;
    this.chunk = row;
    // The old recorder remains active during the asynchronous clock sample.
    if (previous && previous.recorder.state !== "inactive")
      previous.recorder.stop();
    this.timer = setTimeout(() => {
      void this.beginChunk().catch((error) => {
        void this.stop(error.message, true, error).catch(() => {});
      });
    }, this.chunkMs);
  }
  async stop(reason = "已停止录音", discard = false, error = null) {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.reason = reason;
    this.ended = performance.now();
    clearTimeout(this.timer);
    if (this.chunk) this.chunk.discard = discard;
    this.stopping = (async () => {
      if (this.chunk?.recorder.state !== "inactive")
        this.chunk?.recorder.stop();
      const results = await Promise.allSettled([...this.pending]);
      const failure =
        error || results.find((r) => r.status === "rejected")?.reason;
      try {
        this.source?.disconnect();
        this.stream?.getTracks().forEach((track) => track.stop());
        if (this.audio && this.audio.state !== "closed")
          await this.audio.close();
      } finally {
        await this.onStop?.(failure);
      }
      if (failure) throw failure;
      return this.status();
    })();
    return this.stopping;
  }
  status() {
    return {
      active: this.active,
      seconds: Math.max(
        0,
        ((this.ended || performance.now()) -
          (this.started || performance.now())) /
          1000,
      ),
      chunks: this.completed,
      reason: this.reason,
      tracks: this.stream?.getTracks().map((t) => t.readyState) || [],
      audioContext: this.audio?.state || "none",
    };
  }
}
