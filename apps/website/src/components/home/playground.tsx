import { PlaygroundControls } from './playground-controls';
import styles from './playground.module.css';

export function Playground() {
  return (
    <section className={styles.playground} id="playground" aria-labelledby="playgroundTitle">
      <div className={styles.intro}>
        <p className={`micro ${styles.sectionLabel}`}>Small samples. Shared roots.</p>
        <h2 id="playgroundTitle">
          A grove, grown
          <br />
          from a wave.
        </h2>
        <p>
          Each dot is a little canopy. Together, they trace a moving field of colour. Play with the
          palette, freeze a moment, and take a piece with you.
        </p>
        <a className={`text-link ${styles.backToArt}`} href="#artwork">
          Back to the living canvas{' '}
          <span className="arrow" aria-hidden="true">
            ↑
          </span>
        </a>
      </div>
      <PlaygroundControls />
    </section>
  );
}
