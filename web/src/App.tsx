import { toGtin14 } from '@carttweak/shared';

// Placeholder page. UI is out of scope for milestone 1.
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>CartTweak</h1>
      <p>Scaffold only. Shared code check: {toGtin14('036000291452')}</p>
    </main>
  );
}
