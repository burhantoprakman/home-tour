import Link from 'next/link';
import styles from '../components/ui.module.css';

export default function Home() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Home Tour</h1>
      </header>
      <section className={styles.card}>
        <p>Film each room with your phone, and we turn your home into a place friends can visit.</p>
        <div className={styles.row}>
          <Link className={styles.primary} href="/homes">
            My homes
          </Link>
          <Link className={styles.button} href="/signin">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
