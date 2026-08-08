import { HomeScreen } from './HomeScreen';
import { RunScreen } from './RunScreen';
import { TriageScreen } from './TriageScreen';

export function App() {
  const params = new URLSearchParams(window.location.search);
  const runId = Number(params.get('runId'));
  if (Number.isSafeInteger(runId) && runId > 0) {
    return params.get('kind') === 'triage'
      ? <TriageScreen runId={runId} />
      : <RunScreen runId={runId} />;
  }

  return <HomeScreen />;
}
