// offline/midi.js — a MIDI keyboard for the page with no server (CONTRACTS.md §12): Web MIDI
// note on/off into the runtime, the way midio/ feeds the server. Chrome, Edge and Firefox
// have Web MIDI; Safari does not — there the on-screen piano and musical typing still play.
// Like the server's first_keyboard(), an S-1 or an IAC bus is not taken for the keyboard.

const EXCLUDE = ["s-1", "iac"];

/** startMidi({onNote(on, note, vel), onPort(name|null)}) — never throws, never blocks boot. */
export function startMidi({ onNote, onPort }) {
  const nav = globalThis.navigator;
  if (!nav || typeof nav.requestMIDIAccess !== "function") {
    onPort(null);
    return;
  }
  let access = null;

  function onMessage(ev) {
    const [status, note, vel] = ev.data || [];
    const cmd = status & 0xf0;
    if (cmd === 0x90 && vel > 0) onNote(true, note, vel);
    else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) onNote(false, note, vel || 0);
  }

  function scan() {
    const names = [];
    for (const input of access.inputs.values()) {
      const name = input.name || "MIDI keyboard";
      const keyboard = input.state !== "disconnected" && !EXCLUDE.some((x) => name.toLowerCase().includes(x));
      if (keyboard) {
        // The onmidimessage setter opens the port implicitly (addEventListener does not, in
        // every browser); assigning it again on a later scan is harmless.
        if (input.onmidimessage !== onMessage) input.onmidimessage = onMessage;
        names.push(name);
      }
    }
    onPort(names.length ? names[0] : null);
  }

  nav.requestMIDIAccess({ sysex: false }).then((a) => {
    access = a;
    access.addEventListener("statechange", scan);
    scan();
  }, () => onPort(null));
}
