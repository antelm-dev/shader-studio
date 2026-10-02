import styles from './feature-strip.module.css';

const FEATURES = [
  { title: 'Write. See. Repeat.', body: 'Edit GLSL with a live preview.' },
  { title: 'Find your own frequency.', body: 'Tune the controls. Save the feeling.' },
  { title: 'Let your collection grow.', body: 'Keep your shaders, presets and possibilities.' },
];

export function FeatureStrip() {
  return (
    <section id="workflow" className={styles.strip} aria-label="Inside the workspace">
      {FEATURES.map(({ title, body }, index) => (
        <div key={title} className={styles.feature}>
          <span className="micro" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div>
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
        </div>
      ))}
    </section>
  );
}
