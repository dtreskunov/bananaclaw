import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { respondQuestion } from '../actions';
import { isRecording } from '../recorder';
import {
  channelType,
  chatReady,
  groupId,
  isMobile,
  messagingGroupId,
  respondingQuestionIds,
  threadId,
  voiceInput,
} from '../state';
import type { PendingQuestionDto } from '../types';
import { voice, voiceBrowserReason } from '../voice-audio';
import { VoiceButton } from './VoiceButton';

export function QuestionPrompt({ question: q }: { question: PendingQuestionDto }) {
  const [answer, setAnswer] = useState('');
  const [accepted, setAccepted] = useState(false);
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
  const waiting = accepted || q.status === 'answered';
  const disconnected = (!channel || channel === 'web') && !chatReady.value;
  const disabled = busy || waiting || disconnected;
  const current = useRef(false);
  current.current = q.status === 'pending' && !disabled;
  const voiceLocked = active && (voiceState.phase !== 'error' || voiceState.sending);
  const unavailable =
    voiceBrowserReason() ||
    (!voiceInput.value.ready ? voiceInput.value.reason || 'Live voice input is not configured.' : '');
  const canType = q.responseMode !== 'choice';
  const autosize = () => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  useLayoutEffect(autosize, [answer]);

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
      if (sent) setAccepted(true);
      else setError('Could not submit your answer. Please retry.');
      return sent;
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
      aria-label={q.title || 'Question'}
      aria-busy={busy || waiting}
    >
      <div class="question-card-heading">{q.title}</div>
      <div class="question-card-title">{q.question}</div>
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
          <div
            class={`composer-input-wrap question-response-input-wrap${active && voiceState.phase === 'listening' ? ' voice-listening' : ''}`}
          >
            <textarea
              class="question-card-input"
              rows={1}
              value={answer}
              ref={textareaRef}
              disabled={disabled}
              readOnly={voiceLocked}
              aria-label="Your answer"
              placeholder="Type your answer…"
              onInput={(event) => {
                answerRef.current = event.currentTarget.value;
                setAnswer(answerRef.current);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !isMobile.value && !event.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <VoiceButton
              target={target}
              controller={voice}
              onStart={startVoice}
              className="question-response-mic"
              configured={voiceInput.value.ready}
              unavailable={unavailable}
              disabled={disabled || isRecording.value}
            />
            <button
              type="submit"
              class="accent-icon-btn question-response-send"
              aria-label="Send answer"
              title={active && voiceState.phase === 'listening' ? 'Finalize and send answer' : 'Send answer'}
              disabled={
                disabled ||
                (active && (voiceState.sending || !['listening', 'error'].includes(voiceState.phase))) ||
                (!answer.trim() && !active)
              }
              onMouseDown={(event) => event.preventDefault()}
            >
              {'\u2191'}
            </button>
          </div>
        </form>
      )}
      {(busy || waiting || disconnected) && (
        <div class="question-prompt-status" role="status">
          {disconnected ? 'Reconnecting…' : busy ? 'Submitting answer…' : 'Waiting for answer confirmation…'}
        </div>
      )}
      {error && (
        <p class="voice-error" role="alert">
          {error}
        </p>
      )}
      {active && voiceState.error && (
        <p class="voice-error" role="alert">
          {voiceState.error} Nothing is sent automatically.
        </p>
      )}
    </section>
  );
}
