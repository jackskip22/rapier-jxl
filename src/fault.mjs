// SPDX-License-Identifier: MIT
export const fault = (code, message) => Object.assign(new Error(message), {code});
