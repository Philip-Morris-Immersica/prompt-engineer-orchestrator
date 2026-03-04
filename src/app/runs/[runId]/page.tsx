'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

interface IterationSummary {
  iteration: number;
  passRate: number;
  passedCount: number;
  totalCount: number;
  highSeverityCount: number;
  mainIssues: string[];
  changesApplied: string[];
  cost: number;
  delta?: {
    improvements: number;
    regressions: number;
    unchanged: number;
  };
}

interface RunDetails {
  runId: string;
  orchestratorId: string;
  taskId: string;
  status: 'running' | 'success' | 'max_iterations' | 'error';
  startedAt: number;
  completedAt?: number;
  currentIteration: number;
  finalScore?: number;
  totalCost?: number;
  iterations: IterationSummary[];
}

export default function RunDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const runId = params.runId as string;

  const [run, setRun] = useState<RunDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRun();

    // Auto-refresh if running
    const interval = setInterval(() => {
      if (run?.status === 'running') {
        loadRun();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [runId, run?.status]);

  const loadRun = async () => {
    try {
      const response = await fetch(`/api/runs/${runId}`);
      if (response.ok) {
        const data = await response.json();
        setRun(data);
        setError(null);
      } else {
        setError('Run not found');
      }
      setLoading(false);
    } catch (err) {
      setError('Failed to load run');
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      running: 'bg-blue-500',
      success: 'bg-green-500',
      max_iterations: 'bg-yellow-500',
      error: 'bg-red-500',
    };
    const labels = {
      running: 'Running',
      success: 'Success',
      max_iterations: 'Max Iterations',
      error: 'Error',
    };
    return (
      <span
        className={`px-3 py-1 rounded text-white text-sm ${colors[status as keyof typeof colors] || 'bg-gray-500'}`}
      >
        {labels[status as keyof typeof labels] || status}
      </span>
    );
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (start: number, end?: number) => {
    const duration = (end || Date.now()) - start;
    const minutes = Math.floor(duration / 1000 / 60);
    const seconds = Math.floor((duration / 1000) % 60);
    return `${minutes}m ${seconds}s`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-600">Loading run details...</p>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || 'Run not found'}</p>
          <Link href="/">
            <Button>Back to Home</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <Link href="/">
            <Button variant="outline" size="sm">
              ← Back to Home
            </Button>
          </Link>
        </div>

        {/* Header */}
        <header className="mb-8">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Run Details
              </h1>
              <p className="text-gray-600 font-mono text-sm">{runId}</p>
            </div>
            {getStatusBadge(run.status)}
          </div>

          {/* Overview Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Orchestrator</p>
              <p className="text-lg font-semibold">{run.orchestratorId}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Iterations</p>
              <p className="text-lg font-semibold">{run.currentIteration}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Final Score</p>
              <p className="text-lg font-semibold">
                {run.finalScore
                  ? `${(run.finalScore * 100).toFixed(1)}%`
                  : 'In progress'}
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Total Cost</p>
              <p className="text-lg font-semibold">
                {run.totalCost ? `$${run.totalCost.toFixed(2)}` : '$0.00'}
              </p>
            </div>
          </div>
        </header>

        {/* Timeline Section */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-2xl font-semibold mb-4">Timeline</h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Started:</span>
              <span className="font-medium">{formatDate(run.startedAt)}</span>
            </div>
            {run.completedAt && (
              <div className="flex justify-between">
                <span className="text-gray-600">Completed:</span>
                <span className="font-medium">
                  {formatDate(run.completedAt)}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-600">Duration:</span>
              <span className="font-medium">
                {formatDuration(run.startedAt, run.completedAt)}
              </span>
            </div>
          </div>
        </div>

        {/* Iterations Section with Delta */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-2xl font-semibold mb-4">Iteration History</h2>

          {run.iterations.length === 0 ? (
            <p className="text-gray-500">
              {run.status === 'running'
                ? 'Waiting for first iteration to complete...'
                : 'No iterations recorded.'}
            </p>
          ) : (
            <div className="relative">
              {run.iterations.map((iter, idx) => (
                <div
                  key={iter.iteration}
                  className="flex items-start gap-3 pb-6 relative"
                >
                  <div className="flex flex-col items-center">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                        iter.passedCount === iter.totalCount
                          ? 'bg-green-500 text-white'
                          : iter.highSeverityCount > 0
                            ? 'bg-red-500 text-white'
                            : 'bg-yellow-500 text-white'
                      }`}
                    >
                      {iter.iteration}
                    </div>
                    {idx < run.iterations.length - 1 && (
                      <div className="w-0.5 h-full bg-gray-200 mt-2"></div>
                    )}
                  </div>
                  <div className="flex-1 pb-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-medium">Iteration {iter.iteration}</h4>
                        <p className="text-sm text-gray-500">
                          Pass Rate: {iter.passedCount}/{iter.totalCount} ({(iter.passRate * 100).toFixed(1)}%) | Cost:
                          ${iter.cost.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded ${
                            iter.highSeverityCount > 0
                              ? 'bg-red-100 text-red-800'
                              : 'bg-green-100 text-green-800'
                          }`}
                        >
                          {iter.highSeverityCount} high severity
                        </span>
                      </div>
                    </div>
                    
                    {iter.delta && (
                      <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <p className="font-medium text-gray-700 text-sm mb-1">
                          📊 Delta from Previous Iteration:
                        </p>
                        <div className="flex gap-4 text-sm">
                          {iter.delta.improvements > 0 && (
                            <span className="text-green-700 font-medium">
                              ↑ {iter.delta.improvements} improved
                            </span>
                          )}
                          {iter.delta.regressions > 0 && (
                            <span className="text-red-700 font-medium">
                              ↓ {iter.delta.regressions} regressed
                            </span>
                          )}
                          {iter.delta.unchanged > 0 && (
                            <span className="text-gray-600">
                              → {iter.delta.unchanged} unchanged
                            </span>
                          )}
                          {iter.delta.improvements === 0 && iter.delta.regressions === 0 && iter.delta.unchanged === 0 && (
                            <span className="text-gray-500">No changes</span>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {iter.mainIssues.length > 0 && (
                      <div className="mt-3 text-sm">
                        <p className="font-medium text-gray-700">Main Issues:</p>
                        <ul className="list-disc list-inside text-gray-600 mt-1">
                          {iter.mainIssues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {iter.changesApplied.length > 0 && (
                      <div className="mt-2 text-sm">
                        <p className="font-medium text-gray-700">Changes Applied:</p>
                        <ul className="list-disc list-inside text-gray-600 mt-1">
                          {iter.changesApplied.map((change, i) => (
                            <li key={i}>{change}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Status Messages */}
        {run.status === 'running' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-8">
            <p className="text-blue-800">
              ⚙️ Run is in progress. This page will auto-refresh every 3 seconds.
            </p>
          </div>
        )}

        {run.status === 'success' && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-8">
            <p className="text-green-800">
              ✓ Run completed successfully! Final prompt available in run files.
            </p>
          </div>
        )}

        {run.status === 'max_iterations' && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-8">
            <p className="text-yellow-800">
              ⚠️ Run reached maximum iterations. Review the final iteration for
              best results.
            </p>
          </div>
        )}

        {run.status === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
            <p className="text-red-800">
              ✗ Run failed. Check logs for error details.
            </p>
          </div>
        )}

        {/* Files Section */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-2xl font-semibold mb-4">Files Location</h2>
          <p className="text-gray-600 mb-4">
            All run data is saved in the following directory:
          </p>
          <code className="block bg-gray-100 p-4 rounded font-mono text-sm">
            data/runs/{runId}/
          </code>
          <ul className="mt-4 space-y-2 text-sm text-gray-700">
            <li>• metadata.json - Run metadata</li>
            <li>• task.json - Task definition</li>
            <li>• iterations/XX/ - Iteration-specific data</li>
            <li>• final_summary.md - Summary of results</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
