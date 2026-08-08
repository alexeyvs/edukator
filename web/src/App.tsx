import { useEffect, useState, type ReactNode } from 'react';
import { HomeScreen } from './HomeScreen';
import { ProfileScreen } from './ProfileScreen';
import { RunScreen } from './RunScreen';
import { TriageScreen } from './TriageScreen';
import { browserProfileApi, type Profile, type ProfileApi } from './profile-api';

export function ProfileGate({
  api = browserProfileApi,
  children,
}: {
  api?: ProfileApi;
  children: ReactNode;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.read()
      .then((loaded) => { if (active) setProfile(loaded); })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить профиль');
      });
    return () => { active = false; };
  }, [api]);

  if (problem !== null) {
    return <main className="run-state"><p className="home-error" role="alert">{problem}</p></main>;
  }
  if (profile === null) {
    return (
      <main className="run-state" role="status">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        <p>Проверяю профиль…</p>
      </main>
    );
  }
  if (profile.partnerName.trim().length === 0) {
    return <ProfileScreen api={api} initialProfile={profile} onboarding onSaved={setProfile} />;
  }
  return children;
}

export function App() {
  const params = new URLSearchParams(window.location.search);
  const runId = Number(params.get('runId'));
  let screen: ReactNode;
  if (Number.isSafeInteger(runId) && runId > 0) {
    screen = params.get('kind') === 'triage'
      ? <TriageScreen runId={runId} />
      : <RunScreen runId={runId} />;
  } else if (params.get('screen') === 'profile') {
    screen = <ProfileScreen />;
  } else {
    screen = <HomeScreen />;
  }
  return <ProfileGate>{screen}</ProfileGate>;
}
