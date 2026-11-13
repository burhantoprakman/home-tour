import styles from './ui.module.css';

export function RecordingTips() {
  return (
    <details>
      <summary>
        <strong>Recording tips</strong> (read before you film)
      </summary>
      <ul className={styles.tips}>
        <li>One video per room, about 1–3 minutes long.</li>
        <li>
          Turn the lights on and open the curtains. Avoid filming straight into bright windows.
        </li>
        <li>
          Walk slowly along the edge of the room with the phone at chest height, pointing into the
          room. Then do a second, slower loop a little closer to the middle.
        </li>
        <li>Move smoothly: no quick turns, no shaking. Keep the floor and furniture in view.</li>
        <li>Don&apos;t point the camera at a blank wall, mirror or window for long.</li>
        <li>Keep people and pets out of the shot, and don&apos;t move furniture while filming.</li>
        <li>Use the main (1×) camera at 1080p or 4K, 30 fps. MP4, MOV or WebM.</li>
      </ul>
    </details>
  );
}
