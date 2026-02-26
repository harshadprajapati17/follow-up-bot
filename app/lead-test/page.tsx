'use client';

import { useState } from 'react';
import {
  type ConversationState,
  type LeadAnalyzeLikeResponse,
  type Dependency,
  runLeadOrchestrator,
} from '@/lib/leadOrchestrator';
import type { LeadIntentResult } from '@/lib/leadIntent';

type LeadAnalyzeResponse = {
  success: boolean;
} & LeadAnalyzeLikeResponse;

type TraceEntry = {
  label: string;
  detail?: string;
};

function addLog(
  setTrace: React.Dispatch<React.SetStateAction<TraceEntry[]>>,
  label: string,
  detail?: string
) {
  setTrace((prev) => [...prev, { label, detail }]);
}

export default function LeadTestPage() {
  const [text, setText] = useState('');
  const [contractorId, setContractorId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<LeadAnalyzeResponse | null>(null);
  const [rawJson, setRawJson] = useState('');
  const [orchestratorState, setOrchestratorState] = useState<ConversationState>({
    leadStatus: 'NEW',
  });
  const [orchestratorReply, setOrchestratorReply] = useState<string | null>(null);
  const [orchestratorToolCall, setOrchestratorToolCall] = useState<{ name: string; arguments: Record<string, unknown> } | null>(null);
  const [orchestratorDependencies, setOrchestratorDependencies] = useState<Dependency[] | null>(null);
  const [orchestratorMissing, setOrchestratorMissing] = useState<Record<string, boolean> | null>(null);
  const [detectedIntent, setDetectedIntent] = useState<LeadIntentResult | null>(null);
  const [traceLog, setTraceLog] = useState<TraceEntry[]>([]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsLoading(true);
      setResponse(null);
      setRawJson('');
      setOrchestratorReply(null);
      setOrchestratorToolCall(null);
      setOrchestratorDependencies(null);
      setOrchestratorMissing(null);
      setDetectedIntent(null);
      setTraceLog([]);

    try {
      addLog(setTraceLog, '1. Text received', text.trim() || '(empty)');

      addLog(setTraceLog, '2. Calling POST /api/lead/intent', JSON.stringify({ text: text.trim().slice(0, 100) + (text.length > 100 ? '…' : '') }));
      const intentRes = await fetch('/api/lead/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const intentJson = (await intentRes.json()) as
        | { success: true; intent: LeadIntentResult }
        | { success: false; error: string };
      addLog(
        setTraceLog,
        '2. Intent API response',
        JSON.stringify(intentJson, null, 2)
      );

      const intent = intentJson.success ? intentJson.intent : null;
      setDetectedIntent(intent ?? null);

      const needsAnalyze =
        intent &&
        (intent.intent === 'NEW_LEAD' ||
          intent.intent === 'GENERATE_QUOTE_OPTIONS' ||
          intent.intent === 'UPDATE_EXISTING_LEAD');

      addLog(
        setTraceLog,
        '3. Decision',
        needsAnalyze
          ? `needsAnalyze = true (intent: ${intent?.intent}) → will call /api/lead/analyze`
          : `needsAnalyze = false (intent: ${intent?.intent ?? 'none'}) → skipping analyze`
      );

      let json: LeadAnalyzeResponse;
      if (needsAnalyze) {
        addLog(setTraceLog, '4. Calling POST /api/lead/analyze', 'request body: { text, contractor_id? }');
        const analyzeRes = await fetch('/api/lead/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contractor_id: contractorId || undefined,
            text,
          }),
        });
        json = (await analyzeRes.json()) as LeadAnalyzeResponse;
        addLog(setTraceLog, '4. Analyze API response', JSON.stringify(json, null, 2));
      } else {
        json = { success: true };
        addLog(setTraceLog, '4. Analyze skipped', 'Using stub: { success: true }');
      }

      setResponse(json);
      setRawJson(JSON.stringify(json, null, 2));

      addLog(setTraceLog, '5. Orchestrator input', `state: ${JSON.stringify(orchestratorState)}, intent: ${intent?.intent ?? 'undefined'}`);
      const { reply, newState, toolCall, dependencies, missing } = runLeadOrchestrator({
        text,
        state: orchestratorState,
        analysis: json,
        intent: intent ?? undefined,
        measurements: undefined, // TODO: Pass actual measurements from your data source
      });
      setOrchestratorState(newState);
      setOrchestratorReply(reply);
      setOrchestratorToolCall(toolCall ?? null);
      setOrchestratorDependencies(dependencies ?? null);
      setOrchestratorMissing(missing ?? null);
      addLog(
        setTraceLog,
        '5. Orchestrator output',
        `reply: ${reply}\nnewState: ${JSON.stringify(newState, null, 2)}${toolCall ? `\ntoolCall: ${JSON.stringify(toolCall, null, 2)}` : ''}${dependencies ? `\ndependencies: ${JSON.stringify(dependencies, null, 2)}` : ''}${missing ? `\nmissing: ${JSON.stringify(missing, null, 2)}` : ''}`
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Request failed. Check console for details.';
      setResponse({
        success: false,
        error: errMsg,
      });
      addLog(setTraceLog, 'Error', errMsg);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6 md:p-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold text-gray-900">
            Lead Text Analyzer Tester
          </h1>
          <p className="text-sm text-gray-600">
            Paste any customer/contractor utterance below and see how the{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
              /api/lead/analyze
            </code>{' '}
            endpoint structures it.
          </p>
        </header>

        <section className="rounded-lg bg-white p-4 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label
                htmlFor="contractorId"
                className="block text-sm font-medium text-gray-700"
              >
                Contractor ID (optional)
              </label>
              <input
                id="contractorId"
                type="text"
                value={contractorId}
                onChange={(e) => setContractorId(e.target.value)}
                placeholder="c_123"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="text"
                className="block text-sm font-medium text-gray-700"
              >
                Lead text / transcript
              </label>
              <textarea
                id="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="New lead add karo. 2BHK interior repaint. Location: HSR, 27th Main. Customer: Rahil. Site visit Saturday 11am."
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading || !text.trim()}
              className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isLoading ? 'Analyzing…' : 'Analyze lead'}
            </button>
          </form>
        </section>

        {traceLog.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-800">
              Process log
            </h2>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs">
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {traceLog.map((entry, i) => (
                  <div key={i} className="rounded border border-gray-200 bg-white p-2">
                    <div className="font-semibold text-gray-700">{entry.label}</div>
                    {entry.detail && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-gray-600">
                        {entry.detail}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {response && (
          <section className="space-y-3">
            <div className="rounded-lg bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-gray-800">
                Summary
              </h2>
              {response.success ? (
                <ul className="list-inside list-disc text-sm text-gray-700 space-y-1">
                  <li>
                    <span className="font-medium">Success:</span> lead analyzed
                    successfully.
                  </li>
                  {orchestratorReply && (
                    <li>
                      <span className="font-medium">Orchestrator reply:</span>{' '}
                      {orchestratorReply}
                    </li>
                  )}
                  {orchestratorToolCall && (
                    <li>
                      <span className="font-medium">Tool Call:</span>{' '}
                      <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                        {orchestratorToolCall.name}
                      </code>
                      <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600">
                        {JSON.stringify(orchestratorToolCall.arguments, null, 2)}
                      </pre>
                    </li>
                  )}
                  {orchestratorDependencies && orchestratorDependencies.length > 0 && (
                    <li>
                      <span className="font-medium">Pending Dependencies:</span>
                      <ul className="mt-1 list-inside list-disc pl-4 space-y-1">
                        {orchestratorDependencies.map((dep, idx) => (
                          <li key={idx} className="text-xs">
                            <span className="font-semibold text-orange-600">
                              [{dep.type}]
                            </span>{' '}
                            {dep.message}
                            {dep.action && (
                              <span className="text-gray-500 ml-1">
                                (Action: {dep.action})
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  )}
                  {orchestratorMissing && Object.keys(orchestratorMissing).length > 0 && (
                    <li>
                      <span className="font-medium">Missing fields:</span>{' '}
                      {Object.keys(orchestratorMissing).join(', ')}
                    </li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-red-600">
                  Error: {response.error ?? 'Unknown error'}
                </p>
              )}
            </div>

            <div className="rounded-lg bg-black p-4 text-sm text-green-200">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-300">
                Raw JSON response
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
                {rawJson || JSON.stringify(response, null, 2)}
              </pre>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

