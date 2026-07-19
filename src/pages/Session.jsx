import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Loading } from './Home.jsx';
import ConversationLesson from './ConversationLesson.jsx';
import ExerciseFlow from './ExerciseFlow.jsx';

// Practice orchestrator. The primary experience is a conversation-driven
// neighborhood lesson with Laoshi. If the teacher model is unavailable (no
// Ollama and no DashScope key), it falls back to the flashcard exercise flow so
// Practice is always usable.
export default function Session() {
  const [mode, setMode] = useState('loading');   // loading | lesson | exercise
  const [plan, setPlan] = useState(null);
  const [nonce, setNonce] = useState(0);

  const loadPlan = useCallback(() => {
    setMode('loading');
    api.lessonPlan()
      .then(p => { setPlan(p); setMode('lesson'); })
      .catch(() => setMode('exercise'));
  }, []);
  useEffect(loadPlan, [loadPlan, nonce]);

  if (mode === 'loading') return <Loading />;
  if (mode === 'exercise') return <ExerciseFlow />;
  return (
    <ConversationLesson
      key={nonce}
      plan={plan}
      onDone={() => setNonce(n => n + 1)}
      onFallback={() => setMode('exercise')}
    />
  );
}
