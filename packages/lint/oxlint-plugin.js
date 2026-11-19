// Oxlint rules that keep design decisions in CSS, where ds/token-values can
// check them against the tokens (P8, B2).
//
// Oxlint's JS plugin API is alpha and not covered by semver, so the root
// package.json pins oxlint to an exact version.

const RAW_HEX = /^#(?:[0-9a-fA-F]{3,4}){1,2}$/;
const RAW_COLOR_FUNCTION = /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;

const noInlineStyle = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid inline style props in product code.' },
    messages: {
      inlineStyle: 'Put styles in CSS that uses design tokens (P8). Inline styles bypass the token lint.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'style') {
          context.report({ node, messageId: 'inlineStyle' });
        }
      },
    };
  },
};

const noRawColor = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw color strings in product code.' },
    messages: {
      rawColor: 'Raw color in code. Use a color.* token from CSS (P8, B2).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (
          typeof node.value === 'string' &&
          (RAW_HEX.test(node.value) || RAW_COLOR_FUNCTION.test(node.value))
        ) {
          context.report({ node, messageId: 'rawColor' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'ds' },
  rules: {
    'no-inline-style': noInlineStyle,
    'no-raw-color': noRawColor,
  },
};
