import { useEffect, useRef, useState } from 'preact/hooks';
import { respondQuestion, skipQuestion } from '../actions';
import { isRecording } from '../recorder';
import {
  channelType,
  chatReady,
  groupId,
  messagingGroupId,
  respondingQuestionIds,
  threadId,
  voiceInput,
} from '../state';
import type { PendingQuestionDto } from '../types';
import { voice, voiceBrowserReason } from '../voice-audio';
import { ComposerInput, useComposerTextarea } from './ComposerInput';

export function QuestionPrompt({ question: q }: { question: PendingQuestionDto }) {
  const [answer, setAnswer] = useState('');
  const [accepted, setAccepted] = useState<'answer' | 'skipped' | null>(null);
  const [error, setError] = useState('');
  const answerRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submitting = useRef(false);
  const gid = groupId.value;
  const tid = threadId.value;
  const channel = channelType.value;
  const mg = messagingGroupId.value;
  const target = `${gid}:${tid}:question:${q.questionId}`;
  const voiceState = voice.state.value;
  const active = voiceState.target === target;
  const busy = respondingQuestionIds.value.has(q.questionId);
  const waiting = !!accepted || q.status === 'answered';
  const skipped = accepted === 'skipped' || q.answerType === 'skipped';
  const disconnected = (!channel || channel === 'web') && !chatReady.value;
  const disabled = busy || waiting || disconnected;
  const skipDisabled = busy || !!accepted || disconnected || q.status === 'cancelled' || (waiting && !skipped);
  const current = useRef(false);
  current.current = q.status === 'pending' && !disabled;
  const voiceLocked = active && (voiceState.phase !== 'error' || voiceState.sending);
  const unavailable =
    voiceBrowserReason() ||
    (!voiceInput.value.ready ? voiceInput.value.reason || 'Live voice input is not configured.' : '');
  const canType = q.responseMode !== 'choice';
  const { autosize, multiLine } = useComposerTextarea(textareaRef, answer, null);

  const submit = async (value = answerRef.current.trim()): Promise<boolean> => {
    if (
      !value.trim() ||
      submitting.current ||
      !current.current ||
      groupId.value !== gid ||
      threadId.value !== tid ||
      channelType.value !== channel ||
      messagingGroupId.value !== mg
    )
      return false;
    submitting.current = true;
    setError('');
    try {
      const sent = await respondQuestion(q.questionId, value);
      if (sent) setAccepted('answer');
      else setError('Could not submit your answer. Please retry.');
      return sent;
    } finally {
      submitting.current = false;
    }
  };
  const skip = async () => {
    if (
      submitting.current ||
      skipDisabled ||
      groupId.value !== gid ||
      threadId.value !== tid ||
      channelType.value !== channel ||
      messagingGroupId.value !== mg
    )
      return;
    submitting.current = true;
    setError('');
    if (voice.state.value.target === target) voice.detach();
    try {
      const sent = await skipQuestion(q.questionId);
      if (sent) setAccepted('skipped');
      else setError('Could not skip this question. Please retry.');
    } finally {
      submitting.current = false;
    }
  };
  const startVoice = () => {
    if (!gid || !tid || unavailable || !current.current || isRecording.value) return;
    voice.start(
      {
        key: target,
        groupId: gid,
        threadId: tid,
        channelType: channel,
        messagingGroupId: mg,
        getText: () => answerRef.current,
        setText: (text) => {
          answerRef.current = text;
          setAnswer(text);
        },
        isCurrent: () =>
          groupId.value === gid &&
          threadId.value === tid &&
          channelType.value === channel &&
          messagingGroupId.value === mg &&
          current.current,
        send: submit,
      },
      textareaRef.current?.selectionStart ?? answerRef.current.length,
    );
  };
  useEffect(() => {
    if ((waiting || q.status !== 'pending') && voice.state.value.target === target) voice.detach();
  }, [waiting, q.status, target]);
  useEffect(
    () => () => {
      if (voice.state.value.target === target) voice.detach();
    },
    [target, channel, mg],
  );

  return (
    <section
      class="question-prompt"
      data-question-id={q.questionId}
      aria-label={q.question || 'Question'}
      aria-busy={busy || waiting}
    >
      <div class="question-prompt-header">
        <div class="question-prompt-text">{q.question}</div>
        <button
          type="button"
          class="question-skip-btn"
          aria-label="Skip question and notify agent"
          title="Skip this question and tell the agent"
          disabled={skipDisabled}
          onClick={() => void skip()}
        >
          {q.answerType === 'skipped' && !accepted ? 'Retry skip' : 'Skip'}
        </button>
      </div>
      {!!q.options.length && (
        <div class="question-card-actions">
          {q.options.map((option) => (
            <button
              type="button"
              class="question-card-btn"
              key={option.value}
              disabled={disabled}
              onClick={() => {
                if (voice.state.value.target === target) voice.detach();
                void submit(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {canType && (
        <form
          class="question-card-text-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            if (active) voice.send();
            else void submit();
          }}
        >
          <ComposerInput
            inputRef={textareaRef}
            multiLine={multiLine}
            listening={active && voiceState.phase === 'listening'}
            className="question-response-input-wrap"
            textarea={{
              class: 'question-card-input',
              value: answer,
              disabled,
              readOnly: voiceLocked,
              'aria-label': 'Your answer',
              placeholder: 'Type your answer…',
              onInput: (event) => {
                answerRef.current = event.currentTarget.value;
                setAnswer(answerRef.current);
                autosize();
              },
            }}
            voice={{
              target, controller: voice, onStart: startVoice,
              className: 'question-response-mic',
              configured: voiceInput.value.ready,
              unavailable,
              disabled: disabled || isRecording.value,
            }}
            send={{
              className: 'question-response-send',
              label: 'Send answer',
              title: active && voiceState.phase === 'listening' ? 'Finalize and send answer' : 'Send answer',
              disabled:
                disabled ||
                (active && (voiceState.sending || !['listening', 'error'].includes(voiceState.phase))) ||
                (!answer.trim() && !active),
            }}
          />
        </form>
      )}
      {(busy || waiting || disconnected) && (
        <div class="question-prompt-status" role="status">
          {disconnected
            ? 'Reconnecting…'
            : busy
              ? 'Submitting response…'
              : skipped
                ? 'Waiting for skip confirmation…'
                : 'Waiting for answer confirmation…'}
        </div>
      )}
      {error && (
        <p class="inline-error voice-error" role="alert">
          {error}
        </p>
      )}
      {active && voiceState.error && (
        <p class="inline-error voice-error" role="alert">
          <span class="inline-error-copy">
            <strong>Dictation stopped</strong>
            <span>{voiceState.error}</span>
            <span class="inline-error-guidance">Your answer was not sent. Review it before sending.</span>
          </span>
        </p>
      )}
    </section>
  );
}
