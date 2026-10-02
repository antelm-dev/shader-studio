import { PaletteCaption } from './palette-caption';
import styles from './site-footer.module.css';

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span>Shadergrove — built from light, yours to shape.</span>
      <PaletteCaption />
    </footer>
  );
}
