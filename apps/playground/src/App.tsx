import styles from './App.module.css';

// Index of approved reference screens. Empty until the owner approves one.
export function App() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Reference screens</h1>
      <p className={styles.note}>None yet. A screen appears here after the owner approves it.</p>
    </main>
  );
}
