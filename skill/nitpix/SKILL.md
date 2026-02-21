Process one UI review task from the review queue.

## Steps

1. Fetch the next pending task from the review server:
   ```bash
   curl -s http://localhost:4173/api/tasks/next
   ```

2. If the response is `null`, report "Queue is empty — no pending tasks" and stop.

3. Claim the task by setting its status to `in_progress`:
   ```bash
   curl -s -X PUT http://localhost:4173/api/tasks/TASK_ID \
     -H "Content-Type: application/json" \
     -d '{"status": "in_progress"}'
   ```

4. Read the screenshot image at the task's `screenshotPath` (relative to the project root). Use the Read tool to view it — you can see images.

5. Read the source file:
   - For element-type tasks: read `element.sourceFile` at `element.sourceLine`
   - For page-type tasks: read `page.sourceFile`
   - For region-type tasks: use the screenshot and the `region.rect` bounds to understand the area of concern

6. Understand the developer's note in context of:
   - What you see in the screenshot
   - The source code at the referenced location
   - The element's CSS selector (if provided) to locate it in the code
   - The element's `computedStyles` (if provided) to understand the current visual state

7. Check the task's `attempts` array. If it has previous attempts, read them carefully:
   - Each attempt has `agentNotes` (what was tried), `retryReason` (why it was rejected), and optionally an `afterScreenshot` (what the fix looked like)
   - If an `afterScreenshot` path exists, read that image to see what your previous fix produced
   - Use this context to avoid repeating the same mistake

8. Make the code change. Keep changes minimal and focused on exactly what the note describes.

9. After making changes, mark the task for review:
   ```bash
   curl -s -X PUT http://localhost:4173/api/tasks/TASK_ID \
     -H "Content-Type: application/json" \
     -d '{
       "status": "review",
       "agentNotes": "Brief description of what you changed and why",
       "filesModified": ["path/to/file1.tsx", "path/to/file2.css"]
     }'
   ```

10. Report what you did: which file(s) you changed, what the change was, and why it addresses the note.

## Important

- Process exactly ONE task per invocation. Run `/nitpix` again for the next task.
- Set status to `review` (not `done`) — the developer will accept or retry from the browser side panel.
- If the review server is not running, fall back to reading `.review/queue.json` directly and updating it via CLI:
  ```bash
  nitpix queue-next --project .
  nitpix queue-update TASK_ID '{"status": "review", "agentNotes": "..."}' --project .
  ```

## Permissions Note

When run via `nitpix watch` or `nitpix start`, this skill executes in dangerous mode with `--allowedTools` — file edits and writes happen without user confirmation prompts. The developer is expected to review all changes with `git diff` after tasks complete.
