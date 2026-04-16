/**
 * @file meta/setup.ts
 * Orchestrates the setup process for svelte-ui with parallel execution and dependency management.
 */

/**
 * Interface representing a single setup task.
 */
interface Task {
	name: string;
	command: string[];
	requires?: string[];
}

/**
 * Defines the tasks to be executed.
 */
const tasks: Task[] = [
	{
		name: "Download email blacklist",
		command: ["bun", "meta/scripts/generateEmailBlacklist.ts"]
	}
];

/**
 * Represents the outcome of a task execution.
 */
interface TaskResult {
	success: boolean;
	name: string;
	duration: number;
	error?: string;
}

/**
 * Formats the execution duration into a readable string.
 * @param ms - The time in milliseconds.
 * @returns The formatted time string.
 */
const formatTime = (ms: number): string =>
	ms > 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

/**
 * Runs a command asynchronously using Bun's native spawner.
 * @param task - The task object containing the command to run.
 * @returns A promise resolving to the task result.
 */
async function runTaskAsync(task: Task): Promise<TaskResult> {
	const start = performance.now();

	try {
		const proc = Bun.spawn(task.command, {
			stdout: "pipe",
			stderr: "pipe"
		});

		const exitCode = await proc.exited;
		const duration = performance.now() - start;

		if (exitCode !== 0) {
			const errorOutput = await new Response(proc.stderr).text();
			return { success: false, name: task.name, duration, error: errorOutput };
		}

		return { success: true, name: task.name, duration };
	} catch (error: unknown) {
		return { success: false, name: task.name, duration: 0, error: (error as Error).message };
	}
}

/**
 * A registry to hold the execution promises of all tasks.
 * This ensures each task is only run once, and dependent tasks can await it.
 */
const executionRegistry = new Map<string, Promise<TaskResult>>();

/**
 * Orchestrates a single task, waiting for its dependencies first.
 * @param task - The task to execute.
 * @returns A promise that resolves when the task and its dependencies are complete.
 */
function orchestrateTask(task: Task): Promise<TaskResult> {
	if (executionRegistry.has(task.name)) {
		return executionRegistry.get(task.name)!;
	}

	const executionPromise = (async () => {
		if (task.requires && task.requires.length > 0) {
			const depPromises = task.requires.map((reqName) => {
				const reqTask = tasks.find((t) => t.name === reqName);
				if (!reqTask) {
					throw new Error(`Task '${task.name}' requires unknown task '${reqName}'`);
				}
				return orchestrateTask(reqTask);
			});

			const depResults = await Promise.all(depPromises);

			const failedDep = depResults.find((r) => !r.success);
			if (failedDep) {
				const msg = `Skipped: Dependency '${failedDep.name}' failed.`;
				console.log(`⏭️  ${task.name} [SKIPPED]`);
				return { success: false, name: task.name, duration: 0, error: msg };
			}
		}

		const result = await runTaskAsync(task);
		const timeStr = formatTime(result.duration);

		if (result.success) {
			console.log(`✅ ${result.name} - (${timeStr})`);
		} else {
			console.error(`\n❌ Error during: ${result.name}`);
			console.error(`Command: ${task.command.join(" ")}`);
			console.error(result.error);
		}

		return result;
	})();

	executionRegistry.set(task.name, executionPromise);

	return executionPromise;
}

/**
 * Initializes the entire setup sequence.
 */
async function init(): Promise<void> {
	console.log("🚀 Starting setup...");

	const totalStart = performance.now();

	const results = await Promise.all(tasks.map((t) => orchestrateTask(t)));

	const allPassed = results.every((res) => res.success);
	const totalDuration = formatTime(performance.now() - totalStart);

	if (!allPassed) {
		console.error(`\n💥 Setup failed after ${totalDuration}.`);
		process.exit(1);
	}

	console.log(`✨ Setup complete in ${totalDuration}.\n`);
}

init();
