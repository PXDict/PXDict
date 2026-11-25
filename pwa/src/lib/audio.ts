// Plays pronunciation audio from articles in the page itself (sandboxed frames cannot reliably play
// it, and a same-origin request goes through the service worker, so played audio works offline).
let current: HTMLAudioElement | undefined;

export function playAudio(url: string): void {
  current?.pause();
  current = new Audio(url);
  current.play().catch(() => {
    // Autoplay refused or the file failed: nothing else to do.
  });
}
