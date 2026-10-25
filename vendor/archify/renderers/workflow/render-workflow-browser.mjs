import { compileWorkflow } from './workflow-compiler.mjs';
import { throwDiagnosticError } from '../shared/diagnostics.mjs';
import { applyTemplate, renderCards } from '../shared/utils.mjs';

export async function renderWorkflowHtml(diagram, template) {
  const compiled = compileWorkflow({
    workflow: diagram,
    qualityProfile: diagram.meta?.quality_profile,
  });
  if (!compiled.ok) throwDiagnosticError(compiled.error || 'Workflow compilation failed.', compiled.diagnostics);
  return applyTemplate(template, {
    title: diagram.meta.title,
    subtitle: diagram.meta.subtitle,
    svg: compiled.svg,
    cards: renderCards(diagram.cards),
    locale: diagram.meta.locale,
    visualPreset: diagram.meta.visual_preset || 'classic',
    guidedViews: diagram.meta.views || [],
    sourceEvidence: null,
  });
}
