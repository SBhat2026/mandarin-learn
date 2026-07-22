import { useState } from 'react';
import Converse from './Converse.jsx';
import ExerciseFlow from './ExerciseFlow.jsx';

// Practice orchestrator. The primary experience is one continuous conversation with
// Laoshi (the unified surface). If the teacher model is unavailable (no Ollama and
// no DashScope key), it falls back to the flashcard exercise flow so Practice is
// always usable.
export default function Session() {
  const [mode, setMode] = useState('converse');   // converse | exercise
  if (mode === 'exercise') return <ExerciseFlow />;
  return <Converse onFallback={() => setMode('exercise')} />;
}
