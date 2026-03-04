'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

interface OrchestratorInfo {
  id: string;
  name: string;
  category?: string;
}

interface RunMetadata {
  runId: string;
  orchestratorId: string;
  taskId: string;
  status: 'running' | 'success' | 'max_iterations' | 'error';
  startedAt: number;
  completedAt?: number;
  currentIteration: number;
  finalScore?: number;
  totalCost?: number;
}

export default function Home() {
  const [orchestrators, setOrchestrators] = useState<OrchestratorInfo[]>([]);
  const [runs, setRuns] = useState<RunMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [selectedOrchestrator, setSelectedOrchestrator] = useState('');
  const [taskName, setTaskName] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [requirements, setRequirements] = useState('');
  const [stressMode, setStressMode] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 3000); // Refresh every 3 seconds
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [orchResponse, runsResponse] = await Promise.all([
        fetch('/api/orchestrators'),
        fetch('/api/runs'),
      ]);

      if (orchResponse.ok) {
        const orchData = await orchResponse.json();
        setOrchestrators(orchData);
        if (orchData.length > 0 && !selectedOrchestrator) {
          setSelectedOrchestrator(orchData[0].id);
        }
      }

      if (runsResponse.ok) {
        const runsData = await runsResponse.json();
        setRuns(runsData);
      }

      setLoading(false);
    } catch (error) {
      console.error('Failed to load data:', error);
      setLoading(false);
    }
  };

  const startRun = async () => {
    if (!selectedOrchestrator || !taskName || !taskDescription) {
      alert('Please fill in all required fields');
      return;
    }

    setStarting(true);

    try {
      const task = {
        id: `task_${Date.now()}`,
        name: taskName,
        description: taskDescription,
        requirements: {
          role: taskDescription,
          constraints: requirements.split('\n').filter((l) => l.trim()),
          tone: 'Professional',
        },
        category: 'custom',
      };

      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orchestratorId: selectedOrchestrator,
          task,
          stressMode,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        alert(`Run started: ${result.runId}`);
        setShowForm(false);
        loadData();
      } else {
        const error = await response.json();
        alert(`Failed to start run: ${error.error}`);
      }
    } catch (error) {
      alert(`Error: ${(error as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      running: 'bg-blue-500',
      success: 'bg-green-500',
      max_iterations: 'bg-yellow-500',
      error: 'bg-red-500',
    };
    return colors[status as keyof typeof colors] || 'bg-gray-500';
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
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Prompt Refinement Engine
          </h1>
          <p className="text-gray-600">
            Automated prompt generation, testing, and refinement
          </p>
        </header>

        {/* Start New Run Section */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-semibold">Start New Run</h2>
            <Button onClick={() => setShowForm(!showForm)}>
              {showForm ? 'Cancel' : 'New Run'}
            </Button>
          </div>

          {showForm && (
            <div className="space-y-4 border-t pt-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Orchestrator
                </label>
                <select
                  className="w-full border rounded-md p-2"
                  value={selectedOrchestrator}
                  onChange={(e) => setSelectedOrchestrator(e.target.value)}
                >
                  {orchestrators.map((orch) => (
                    <option key={orch.id} value={orch.id}>
                      {orch.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Task Name *
                </label>
                <input
                  type="text"
                  className="w-full border rounded-md p-2"
                  value={taskName}
                  onChange={(e) => setTaskName(e.target.value)}
                  placeholder="e.g. Customer Support Bot"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Task Description *
                </label>
                <textarea
                  className="w-full border rounded-md p-2 h-24"
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Describe what the chatbot should do..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Requirements (one per line)
                </label>
                <textarea
                  className="w-full border rounded-md p-2 h-32"
                  value={requirements}
                  onChange={(e) => setRequirements(e.target.value)}
                  placeholder="Enter constraints and requirements..."
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="stress"
                  checked={stressMode}
                  onChange={(e) => setStressMode(e.target.checked)}
                />
                <label htmlFor="stress" className="text-sm">
                  Stress Mode (temp=0.9)
                </label>
              </div>

              <Button
                onClick={startRun}
                disabled={starting}
                className="w-full"
              >
                {starting ? 'Starting...' : 'Start Refinement'}
              </Button>
            </div>
          )}
        </div>

        {/* Recent Runs Section */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-2xl font-semibold mb-4">Recent Runs</h2>

          {runs.length === 0 ? (
            <p className="text-gray-500">No runs yet. Start your first run above!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-4">Run ID</th>
                    <th className="text-left py-2 px-4">Orchestrator</th>
                    <th className="text-left py-2 px-4">Status</th>
                    <th className="text-left py-2 px-4">Iteration</th>
                    <th className="text-left py-2 px-4">Score</th>
                    <th className="text-left py-2 px-4">Started</th>
                    <th className="text-left py-2 px-4">Duration</th>
                    <th className="text-left py-2 px-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.runId} className="border-b hover:bg-gray-50">
                      <td className="py-2 px-4 font-mono text-sm">
                        {run.runId.substring(0, 16)}...
                      </td>
                      <td className="py-2 px-4">{run.orchestratorId}</td>
                      <td className="py-2 px-4">
                        <span
                          className={`px-2 py-1 rounded text-white text-xs ${getStatusBadge(run.status)}`}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="py-2 px-4">{run.currentIteration}</td>
                      <td className="py-2 px-4">
                        {run.finalScore
                          ? `${(run.finalScore * 100).toFixed(0)}%`
                          : '-'}
                      </td>
                      <td className="py-2 px-4 text-sm">
                        {formatDate(run.startedAt)}
                      </td>
                      <td className="py-2 px-4 text-sm">
                        {formatDuration(run.startedAt, run.completedAt)}
                      </td>
                      <td className="py-2 px-4">
                        <Link href={`/runs/${run.runId}`}>
                          <Button size="sm" variant="outline">
                            View
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
