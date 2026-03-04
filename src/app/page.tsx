'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileUpload } from './components/FileUpload';
import Link from 'next/link';

interface Orchestrator {
  id: string;
  name: string;
}

interface Run {
  runId: string;
  orchestratorId: string;
  taskId: string;
  status: 'running' | 'success' | 'max_iterations' | 'error';
  startedAt: number;
  currentIteration: number;
  finalScore?: number;
}

export default function Home() {
  const [orchestrators, setOrchestrators] = useState<Orchestrator[]>([]);
  const [selectedOrchestrator, setSelectedOrchestrator] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [stressMode, setStressMode] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);

  useEffect(() => {
    loadOrchestrators();
    loadRuns();

    const interval = setInterval(loadRuns, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadOrchestrators = async () => {
    try {
      const response = await fetch('/api/orchestrators');
      if (response.ok) {
        const data = await response.json();
        setOrchestrators(data);
        if (data.length > 0) {
          setSelectedOrchestrator(data[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load orchestrators:', error);
    }
  };

  const loadRuns = async () => {
    try {
      const response = await fetch('/api/runs');
      if (response.ok) {
        const data = await response.json();
        setRuns(data);
      }
    } catch (error) {
      console.error('Failed to load runs:', error);
    }
  };

  const handleStartRun = async () => {
    if (!selectedOrchestrator) {
      alert('Please select an orchestrator');
      return;
    }

    if (!taskInput.trim()) {
      alert('Please provide task input');
      return;
    }

    let task;
    try {
      task = JSON.parse(taskInput);
    } catch (e) {
      alert('Invalid JSON format for task');
      return;
    }

    // Add upload info if files were uploaded
    if (uploadId) {
      task.uploadId = uploadId;
    }

    setLoading(true);
    try {
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
        const data = await response.json();
        alert(`Run started! ID: ${data.runId}`);
        setTaskInput('');
        setUploadId(null);
        setUploadedFiles([]);
        loadRuns();
      } else {
        const error = await response.json();
        alert(`Failed to start run: ${error.error}`);
      }
    } catch (error) {
      alert('Failed to start run');
    } finally {
      setLoading(false);
    }
  };

  const handleUploadComplete = (newUploadId: string, files: string[]) => {
    setUploadId(newUploadId);
    setUploadedFiles(files);
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      running: 'bg-blue-500',
      success: 'bg-green-500',
      max_iterations: 'bg-yellow-500',
      error: 'bg-red-500',
    };
    return (
      <span
        className={`px-2 py-1 rounded text-white text-xs font-medium ${colors[status as keyof typeof colors] || 'bg-gray-500'}`}
      >
        {status}
      </span>
    );
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="max-w-7xl mx-auto p-8">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            🤖 Prompt Refinement Engine
          </h1>
          <p className="text-gray-600">
            Automated prompt generation, testing, and refinement system
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Start New Run */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
              <h2 className="text-2xl font-semibold text-gray-900 mb-6 flex items-center">
                <span className="bg-blue-100 text-blue-600 w-8 h-8 rounded-full flex items-center justify-center mr-3 text-sm font-bold">
                  1
                </span>
                Start New Run
              </h2>

              <div className="space-y-6">
                {/* Orchestrator Selection */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Select Orchestrator
                  </label>
                  <select
                    value={selectedOrchestrator}
                    onChange={(e) => setSelectedOrchestrator(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  >
                    {orchestrators.map((orch) => (
                      <option key={orch.id} value={orch.id}>
                        {orch.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Choose the orchestrator configuration for your chatbot type
                  </p>
                </div>

                {/* File Upload */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Upload Reference Materials (Optional)
                  </label>
                  <FileUpload onUploadComplete={handleUploadComplete} />
                  {uploadedFiles.length > 0 && (
                    <p className="text-xs text-gray-600 mt-2">
                      ✓ {uploadedFiles.length} file(s) will be included as context
                    </p>
                  )}
                </div>

                {/* Task Input */}
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Task Description (JSON)
                  </label>
                  <textarea
                    value={taskInput}
                    onChange={(e) => setTaskInput(e.target.value)}
                    placeholder='{"id": "task_01", "name": "My Bot", "description": "...", "requirements": {...}, "category": "..."}'
                    rows={8}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm bg-gray-50"
                  />
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-gray-500">
                      See examples in <code className="bg-gray-100 px-1 rounded">examples/tasks/</code>
                    </p>
                    <button
                      onClick={() =>
                        setTaskInput(`{
  "id": "quick_test",
  "name": "Test Bot",
  "description": "A helpful assistant that answers questions",
  "requirements": {
    "role": "Helpful assistant",
    "constraints": ["Be concise", "Stay on topic"],
    "tone": "friendly",
    "maxResponseLength": 500
  },
  "category": "assistant"
}`)
                      }
                      className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Load Example
                    </button>
                  </div>
                </div>

                {/* Options */}
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stressMode}
                      onChange={(e) => setStressMode(e.target.checked)}
                      className="w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-900">
                        Stress Mode
                      </span>
                      <p className="text-xs text-gray-500">
                        Test with high temperature (0.9) for edge case detection
                      </p>
                    </div>
                  </label>
                </div>

                {/* Start Button */}
                <Button
                  onClick={handleStartRun}
                  disabled={loading || !selectedOrchestrator || !taskInput}
                  className="w-full py-6 text-lg font-semibold bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 shadow-lg"
                >
                  {loading ? '🚀 Starting Run...' : '▶️ Start Refinement Run'}
                </Button>
              </div>
            </div>
          </div>

          {/* Right Column - Info Cards */}
          <div className="space-y-6">
            {/* Quick Stats */}
            <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                📊 Quick Stats
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Total Runs</span>
                  <span className="text-lg font-bold text-gray-900">
                    {runs.length}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Active</span>
                  <span className="text-lg font-bold text-blue-600">
                    {runs.filter((r) => r.status === 'running').length}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">Successful</span>
                  <span className="text-lg font-bold text-green-600">
                    {runs.filter((r) => r.status === 'success').length}
                  </span>
                </div>
              </div>
            </div>

            {/* Info Box */}
            <div className="bg-blue-50 rounded-xl shadow-lg p-6 border border-blue-200">
              <h3 className="text-lg font-semibold text-blue-900 mb-3">
                💡 How It Works
              </h3>
              <ol className="text-sm text-blue-800 space-y-2 list-decimal list-inside">
                <li>Upload reference materials (optional)</li>
                <li>Provide task description</li>
                <li>System generates initial prompt</li>
                <li>Tests with 4 fixed scenarios</li>
                <li>Analyzes results & refines</li>
                <li>Repeats until success</li>
              </ol>
            </div>
          </div>
        </div>

        {/* Recent Runs Table */}
        <div className="mt-8 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-2xl font-semibold text-gray-900">
              📋 Recent Runs
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Auto-refreshes every 3 seconds
            </p>
          </div>

          {runs.length === 0 ? (
            <div className="p-12 text-center">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                />
              </svg>
              <p className="mt-4 text-gray-600">
                No runs yet. Start your first refinement run above!
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Run ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Orchestrator
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Iteration
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Score
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Started
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {runs.map((run) => (
                    <tr
                      key={run.runId}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Link
                          href={`/runs/${run.runId}`}
                          className="text-blue-600 hover:text-blue-800 font-mono text-sm font-medium"
                        >
                          {run.runId.substring(0, 8)}...
                        </Link>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {run.orchestratorId}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getStatusBadge(run.status)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {run.currentIteration}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {run.finalScore
                          ? `${(run.finalScore * 100).toFixed(1)}%`
                          : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {formatDate(run.startedAt)}
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
