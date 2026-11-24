// Parakeet sends replaceable hypotheses; Realtime deltas are append-only.
// Publish only whole-word prefixes shared by successive hypotheses. A later
// correction to an emitted prefix waits for the authoritative completed event.
export class StablePartial {
  previous = ''; emitted = '';
  append(snapshot) {
    let n = 0;
    while (n < this.previous.length && n < snapshot.length && this.previous[n] === snapshot[n]) n++;
    this.previous = snapshot;
    const common = snapshot.slice(0, n);
    const boundary = common.search(/\s+\S*$/u);
    const stable = boundary < 0 ? '' : common.slice(0, boundary + 1);
    if (!stable.startsWith(this.emitted) || stable.length <= this.emitted.length) return '';
    const delta = stable.slice(this.emitted.length); this.emitted = stable; return delta;
  }
}
