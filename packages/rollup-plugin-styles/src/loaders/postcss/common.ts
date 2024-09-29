// eslint-disable-next-line security/detect-unsafe-regex
export const hashRe = /\[hash(?::(\d+))?\]/;
export const firstExtRe = /(?<!^|[/\\])(\.[^\s.]+)/;
// eslint-disable-next-line security/detect-unsafe-regex
export const dataURIRe = /data:[^\n\r;]+(?:;charset=[^\n\r;]+)?;base64,([\d+/A-Za-z]+={0,2})/;