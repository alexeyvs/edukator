import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  browserProfileApi,
  type Profile,
  type ProfileApi,
  type ProfilePatch,
} from './profile-api';

export interface ProfileScreenProps {
  api?: ProfileApi;
  initialProfile?: Profile;
  onboarding?: boolean;
  onSaved?: (profile: Profile) => void;
}

interface FormState {
  name: string;
  interests: string;
  examDate: string;
  partnerName: string;
}

function formFrom(profile: Profile): FormState {
  return {
    name: profile.name,
    interests: profile.interests.join(', '),
    examDate: profile.examDate ?? '',
    partnerName: profile.partnerName,
  };
}

function patchFrom(form: FormState): ProfilePatch {
  return {
    name: form.name.trim(),
    partnerName: form.partnerName.trim(),
    examDate: form.examDate === '' ? null : form.examDate,
    interests: form.interests
      .split(',')
      .map((interest) => interest.trim())
      .filter((interest) => interest.length > 0),
  };
}

export function ProfileScreen({
  api = browserProfileApi,
  initialProfile,
  onboarding = false,
  onSaved,
}: ProfileScreenProps) {
  const [profile, setProfile] = useState<Profile | null>(initialProfile ?? null);
  const [form, setForm] = useState<FormState | null>(
    initialProfile === undefined ? null : formFrom(initialProfile),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (initialProfile !== undefined) return;
    let active = true;
    api.read()
      .then((loaded) => {
        if (!active) return;
        setProfile(loaded);
        setForm(formFrom(loaded));
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : 'Не получилось загрузить профиль');
      });
    return () => { active = false; };
  }, [api, initialProfile]);

  function change(field: keyof FormState, value: string): void {
    setForm((current) => current === null ? current : { ...current, [field]: value });
    setSaved(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (form === null) return;
    const patch = patchFrom(form);
    if (patch.name.length === 0) {
      setProblem('Напиши своё имя — пустое имя сохранить нельзя');
      return;
    }
    if (patch.partnerName.length === 0) {
      setProblem('Дай напарнику имя — иначе знакомство не закончится');
      return;
    }

    setProblem(null);
    setSaving(true);
    try {
      const next = await api.save(patch);
      setProfile(next);
      setForm(formFrom(next));
      setSaved(true);
      onSaved?.(next);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Не получилось сохранить профиль');
    } finally {
      setSaving(false);
    }
  }

  if (form === null || profile === null) {
    return (
      <main className="profile-shell">
        <div className="profile-state" role="status">
          <span className="state-mark" aria-hidden="true">…</span>
          <p>{problem ?? 'Открываю профиль…'}</p>
        </div>
      </main>
    );
  }

  return (
    <main className={`profile-shell ${onboarding ? 'onboarding-shell' : ''}`}>
      <header className="profile-header">
        <a className="brand" href="/" aria-label="Эдукатор">Э</a>
        {!onboarding && <a className="profile-home" href="/">К плану дня</a>}
      </header>

      <div className="profile-layout">
        <section className="companion-note" aria-labelledby={`${formId}-title`}>
          <p className="profile-kicker">{onboarding ? 'Давай без церемоний' : 'Настройки напарника'}</p>
          <h1 id={`${formId}-title`}>{onboarding ? 'Сначала познакомимся' : 'Профиль'}</h1>
          {onboarding ? (
            <blockquote>{profile.introduction}</blockquote>
          ) : (
            <p className="profile-lead">Здесь можно поменять детали, которые влияют на план и формулировки заданий.</p>
          )}
        </section>

        <form className="profile-form" onSubmit={(event) => void submit(event)} noValidate>
          <div className="profile-field">
            <label htmlFor={`${formId}-name`}>Как тебя зовут</label>
            <input
              id={`${formId}-name`}
              name="name"
              autoComplete="name"
              value={form.name}
              onChange={(event) => change('name', event.target.value)}
              placeholder="Например, Тимофей"
            />
          </div>

          <div className="profile-field">
            <label htmlFor={`${formId}-partner`}>Как назвать напарника</label>
            <input
              id={`${formId}-partner`}
              name="partnerName"
              value={form.partnerName}
              onChange={(event) => change('partnerName', event.target.value)}
              placeholder="Например, Кекс"
            />
            <small>Можно переименовать потом. Обижаться некому.</small>
          </div>

          <div className="profile-field profile-field-wide">
            <label htmlFor={`${formId}-interests`}>Что тебе интересно</label>
            <input
              id={`${formId}-interests`}
              name="interests"
              value={form.interests}
              onChange={(event) => change('interests', event.target.value)}
              placeholder="скейт, Minecraft, кот Пират"
            />
            <small>Через запятую. Это иногда попадёт в сюжеты заданий.</small>
          </div>

          <div className="profile-field profile-field-wide">
            <label htmlFor={`${formId}-exam`}>Дата экзамена</label>
            <input
              id={`${formId}-exam`}
              name="examDate"
              type="date"
              value={form.examDate}
              onChange={(event) => change('examDate', event.target.value)}
            />
          </div>

          {problem !== null && <p className="profile-message error" role="alert">{problem}</p>}
          {saved && <p className="profile-message success" role="status">Профиль сохранён</p>}

          <button className="primary profile-save" type="submit" disabled={saving}>
            {saving ? 'Сохраняю…' : onboarding ? 'Познакомились. К плану' : 'Сохранить изменения'}
          </button>
        </form>
      </div>
    </main>
  );
}
