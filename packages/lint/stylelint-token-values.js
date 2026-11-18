// Stylelint rule "ds/token-values": design decisions in product CSS must come
// from design tokens (principles P8, bans B2, B5, B11, B16).
//
// Flags:
// - raw colors anywhere (hex, color functions, named colors)
// - absolute lengths (px, rem, em, ...) in spacing, sizing, radius, border
//   width and type properties
// - font, font-family, font-size, font-weight, line-height, letter-spacing
//   and box-shadow values that aren't var()
// - raw durations and easings in transitions and animations
// - var() references to anything that isn't a token or a custom property
//   defined in the same file
//
// Allows structural CSS: 0, auto, %, fr, ch, viewport units, min-content,
// max-content, fit-content, flex and grid layout values, global keywords.
import { readFileSync } from 'node:fs';
import stylelint from 'stylelint';

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

export const ruleName = 'ds/token-values';

export const messages = ruleMessages(ruleName, {
  rawColor: (prop, color) => `Raw color "${color}" in "${prop}". Use a color.* token (P8, B2).`,
  rawLength: (prop, length) => `Raw length "${length}" in "${prop}". Use a space, size, radius or border.width token (P8).`,
  notToken: (prop) => `"${prop}" must use a design token through var() (P8).`,
  rawMotion: (prop, value) => `Raw motion value "${value}" in "${prop}". Use a motion.* token (P8, P10).`,
  unknownVar: (name) => `"${name}" is not a design token or a custom property defined in this file.`,
});

const GLOBAL_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

// CSS named colors; transparent and currentcolor are allowed.
const NAMED_COLORS = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen').split(' '),
);

const HEX = /#[0-9a-f]{3,8}\b/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const ABSOLUTE_LENGTH = /(?<![\w-])-?(?:\d*\.)?\d+(?:px|rem|em|pt|pc|cm|mm|in|q)\b/i;
const DURATION = /(?<![\w-])(?:\d*\.)?\d+m?s\b/i;
const EASING = /\b(?:cubic-bezier\(|steps\(|ease(?:-in|-out|-in-out)?\b)/i;

// Properties whose lengths are design decisions.
const LENGTH_PROPS =
  /^(?:margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|inline-size|block-size|min-inline-size|min-block-size|max-inline-size|max-block-size|flex-basis|border-radius|border-(?:top|bottom|start|end)-(?:left|right|start|end)-radius|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-width)?|outline(?:-width|-offset)?|text-indent|text-underline-offset|scroll-margin|scroll-padding)(?:-.*)?$/;

// Properties that must always be a token (or a global keyword).
const TOKEN_ONLY_PROPS = new Set([
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'box-shadow',
]);
const TOKEN_ONLY_ALLOWED = new Set(['none', 'normal']);

const MOTION_PROPS = /^(?:transition|animation)(?:-duration|-delay|-timing-function)?$/;

function readTokenNames(tokensCss) {
  if (!tokensCss) return null;
  const css = readFileSync(tokensCss, 'utf8');
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

function withoutVars(value) {
  // Drop var(...) so values inside a fallback-free var() aren't flagged.
  let out = value;
  let previous;
  do {
    previous = out;
    out = out.replace(/var\(\s*--[\w-]+\s*\)/g, '');
  } while (out !== previous);
  return out;
}

function firstNamedColor(value) {
  for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NAMED_COLORS.has(word)) return word;
  }
  return null;
}

const ruleFunction = (primary, secondaryOptions) => (root, result) => {
  const valid = validateOptions(
    result,
    ruleName,
    { actual: primary, possible: [true] },
    { actual: secondaryOptions, possible: { tokensCss: [(v) => typeof v === 'string'] }, optional: true },
  );
  if (!valid) return;

  const tokens = readTokenNames(secondaryOptions?.tokensCss);
  const localVars = new Set();
  root.walkDecls(/^--/, (decl) => localVars.add(decl.prop));

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const value = decl.value;
    const flag = (message, word) =>
      report({ message, node: decl, word, result, ruleName });

    if (tokens) {
      for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!tokens.has(name) && !localVars.has(name)) flag(messages.unknownVar(name), name);
      }
    }

    const bare = withoutVars(value);
    if (GLOBAL_KEYWORDS.has(bare.trim().toLowerCase())) return;

    const hex = bare.match(HEX)?.[0];
    const fn = bare.match(COLOR_FUNCTION)?.[0];
    const named = prop.startsWith('--') || /color|background|border|outline|fill|stroke|shadow|caret|decoration/.test(prop)
      ? firstNamedColor(bare.replace(/\b(?:transparent|currentcolor)\b/gi, ''))
      : null;
    const color = hex ?? fn ?? named;
    if (color) return flag(messages.rawColor(prop, color), color);

    if (TOKEN_ONLY_PROPS.has(prop)) {
      const rest = bare.trim().toLowerCase();
      if (rest !== '' && !TOKEN_ONLY_ALLOWED.has(rest)) return flag(messages.notToken(prop), value);
      return;
    }

    if (MOTION_PROPS.test(prop)) {
      const motion = bare.match(DURATION)?.[0] ?? bare.match(EASING)?.[0];
      if (motion && !/^0m?s$/.test(motion)) return flag(messages.rawMotion(prop, motion), motion);
    }

    if (prop.startsWith('--') || LENGTH_PROPS.test(prop)) {
      const length = bare.match(ABSOLUTE_LENGTH)?.[0];
      if (length && !/^-?0+(?:\.0+)?[a-z]+$/i.test(length)) flag(messages.rawLength(prop, length), length);
    }
  });
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;
ruleFunction.meta = { url: 'core/design-system/principles.md#p8-the-system-owns-the-visual-language' };

export default createPlugin(ruleName, ruleFunction);
