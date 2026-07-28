import type { ShaderControl } from '@shader-studio/shared/model';
import { validateControls } from '@shader-studio/shared/validate';

/**
 * The two questions anyone ever asks of the config buffer: "does this text
 * describe a control schema?" and, when it does not, "why not?".
 *
 * They live together, and outside both `DocumentState` and `ProjectMutations`,
 * because both need them and neither owns them: the derived `controls` and
 * `configValid` projections ask the first, and the mutation that writes the
 * config text asks the second to turn a refusal into diagnostics.
 */

/** Returns the parsed schema, or null if the text is not a valid schema. */
export function parseControls(text: string): ShaderControl[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = validateControls(parsed);
  return result.ok ? result.value : null;
}

/** The reason `parseControls` said no, phrased for the diagnostics panel. */
export function configErrors(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [`Config is not valid JSON: ${(error as Error).message}`];
  }
  const result = validateControls(parsed);
  return result.ok ? [] : result.errors;
}
