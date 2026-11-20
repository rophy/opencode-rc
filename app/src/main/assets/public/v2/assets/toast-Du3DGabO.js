import{B as e,F as t,M as n,N as r,P as i,T as a,U as o,_ as s,a as c,c as l,h as u,v as d,x as f,y as p}from"./solid-DlCzZEdX.js";import{_ as m,a as h,c as g,f as _,g as v,m as y,n as ee,o as b,u as x,v as S}from"./web-Dl45KU3J.js";import{r as C}from"./LP6E37CW-pIAlIvrz.js";import{i as w}from"./i18n-kW2u2lZB.js";import{n as T,r as E,t as te}from"./store-TnQwzyQm.js";/* empty css               */import{n as D}from"./reduced-nsQJmDHw.js";var O=m(`<div><div class=sonner-spinner>`),k=m(`<div class=sonner-loading-bar>`),A=m(`<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 20 20"fill=currentColor height=20 width=20><path fill-rule=evenodd d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"clip-rule=evenodd>`),j=m(`<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 24 24"fill=currentColor height=20 width=20><path fill-rule=evenodd d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z"clip-rule=evenodd>`),M=m(`<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 20 20"fill=currentColor height=20 width=20><path fill-rule=evenodd d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"clip-rule=evenodd>`),N=m(`<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 20 20"fill=currentColor height=20 width=20><path fill-rule=evenodd d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"clip-rule=evenodd>`),P=m(`<svg xmlns=http://www.w3.org/2000/svg width=12 height=12 viewBox="0 0 24 24"fill=none stroke=currentColor stroke-width=1.5 stroke-linecap=round stroke-linejoin=round><line x1=18 y1=6 x2=6 y2=18></line><line x1=6 y1=6 x2=18 y2=18>`),F=m(`<div>`),I=m(`<button data-close-button>`),ne=m(`<div data-icon>`),L=m(`<div data-description>`),re=m(`<li tabindex=0 data-sonner-toast><div data-content><div data-title>`),ie=m(`<button data-button data-cancel>`),ae=m(`<button data-button data-action>`),oe=m(`<section tabindex=-1 aria-live=polite aria-relevant="additions text"aria-atomic=false data-react-aria-top-layer>`),R=m(`<ol tabindex=-1 data-sonner-toaster style=--width:356px>`);function z(e,{insertAt:t}={}){if(!e||typeof document>`u`)return;let n=document.head||document.getElementsByTagName(`head`)[0],r=document.createElement(`style`);r.type=`text/css`,t===`top`&&n.firstChild?n.insertBefore(r,n.firstChild):n.appendChild(r),r.styleSheet?r.styleSheet.cssText=e:r.appendChild(document.createTextNode(e))}z(`html[dir=ltr],
[data-sonner-toaster][dir=ltr] {
  --toast-icon-margin-start: -3px;
  --toast-icon-margin-end: 4px;
  --toast-svg-margin-start: -1px;
  --toast-svg-margin-end: 0px;
  --toast-button-margin-start: auto;
  --toast-button-margin-end: 0;
  --toast-close-button-start: 0;
  --toast-close-button-end: unset;
  --toast-close-button-transform: translate(-35%, -35%);
}
html[dir=rtl],
[data-sonner-toaster][dir=rtl] {
  --toast-icon-margin-start: 4px;
  --toast-icon-margin-end: -3px;
  --toast-svg-margin-start: 0px;
  --toast-svg-margin-end: -1px;
  --toast-button-margin-start: 0;
  --toast-button-margin-end: auto;
  --toast-close-button-start: unset;
  --toast-close-button-end: 0;
  --toast-close-button-transform: translate(35%, -35%);
}
[data-sonner-toaster] {
  position: fixed;
  width: var(--width);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    Segoe UI,
    Roboto,
    Helvetica Neue,
    Arial,
    Noto Sans,
    sans-serif,
    Apple Color Emoji,
    Segoe UI Emoji,
    Segoe UI Symbol,
    Noto Color Emoji;
  --gray1: hsl(0, 0%, 99%);
  --gray2: hsl(0, 0%, 97.3%);
  --gray3: hsl(0, 0%, 95.1%);
  --gray4: hsl(0, 0%, 93%);
  --gray5: hsl(0, 0%, 90.9%);
  --gray6: hsl(0, 0%, 88.7%);
  --gray7: hsl(0, 0%, 85.8%);
  --gray8: hsl(0, 0%, 78%);
  --gray9: hsl(0, 0%, 56.1%);
  --gray10: hsl(0, 0%, 52.3%);
  --gray11: hsl(0, 0%, 43.5%);
  --gray12: hsl(0, 0%, 9%);
  --border-radius: 8px;
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  list-style: none;
  outline: none;
  z-index: 999999999;
  transition: transform 400ms ease;
}
@media (hover: none) and (pointer: coarse) {
  [data-sonner-toaster][data-lifted=true] {
    transform: none;
  }
}
[data-sonner-toaster][data-x-position=right] {
  right: var(--offset-right);
}
[data-sonner-toaster][data-x-position=left] {
  left: var(--offset-left);
}
[data-sonner-toaster][data-x-position=center] {
  left: 50%;
  transform: translateX(-50%);
}
[data-sonner-toaster][data-y-position=top] {
  top: var(--offset-top);
}
[data-sonner-toaster][data-y-position=bottom] {
  bottom: var(--offset-bottom);
}
[data-sonner-toast] {
  --y: translateY(100%);
  --lift-amount: calc(var(--lift) * var(--gap));
  z-index: var(--z-index);
  position: absolute;
  opacity: 0;
  transform: var(--y);
  touch-action: none;
  transition:
    transform 400ms,
    opacity 400ms,
    height 400ms,
    box-shadow 200ms;
  box-sizing: border-box;
  outline: none;
  overflow-wrap: anywhere;
}
[data-sonner-toast][data-styled=true] {
  padding: 16px;
  background: var(--normal-bg);
  border: 1px solid var(--normal-border);
  color: var(--normal-text);
  border-radius: var(--border-radius);
  box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
  width: var(--width);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
[data-sonner-toast]:focus-visible {
  box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1), 0 0 0 2px rgba(0, 0, 0, 0.2);
}
[data-sonner-toast][data-y-position=top] {
  top: 0;
  --y: translateY(-100%);
  --lift: 1;
  --lift-amount: calc(1 * var(--gap));
}
[data-sonner-toast][data-y-position=bottom] {
  bottom: 0;
  --y: translateY(100%);
  --lift: -1;
  --lift-amount: calc(var(--lift) * var(--gap));
}
[data-sonner-toast][data-styled=true] [data-description] {
  font-weight: 400;
  line-height: 1.4;
  color: #3f3f3f;
}
[data-rich-colors=true][data-sonner-toast][data-styled=true] [data-description] {
  color: inherit;
}
[data-sonner-toaster][data-sonner-theme=dark] [data-description] {
  color: hsl(0, 0%, 91%);
}
[data-sonner-toast][data-styled=true] [data-title] {
  font-weight: 500;
  line-height: 1.5;
  color: inherit;
}
[data-sonner-toast][data-styled=true] [data-icon] {
  display: flex;
  height: 16px;
  width: 16px;
  position: relative;
  justify-content: flex-start;
  align-items: center;
  flex-shrink: 0;
  margin-left: var(--toast-icon-margin-start);
  margin-right: var(--toast-icon-margin-end);
}
[data-sonner-toast][data-promise=true] [data-icon] > svg {
  opacity: 0;
  transform: scale(0.8);
  transform-origin: center;
  animation: sonner-fade-in 300ms ease forwards;
}
[data-sonner-toast][data-styled=true] [data-icon] > * {
  flex-shrink: 0;
}
[data-sonner-toast][data-styled=true] [data-icon] svg {
  margin-left: var(--toast-svg-margin-start);
  margin-right: var(--toast-svg-margin-end);
}
[data-sonner-toast][data-styled=true] [data-content] {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
[data-sonner-toast][data-styled=true] [data-button] {
  border-radius: 4px;
  padding-left: 8px;
  padding-right: 8px;
  height: 24px;
  font-size: 12px;
  color: var(--normal-bg);
  background: var(--normal-text);
  margin-left: var(--toast-button-margin-start);
  margin-right: var(--toast-button-margin-end);
  border: none;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: opacity 400ms, box-shadow 200ms;
}
[data-sonner-toast][data-styled=true] [data-button]:focus-visible {
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.4);
}
[data-sonner-toast][data-styled=true] [data-button]:first-of-type {
  margin-left: var(--toast-button-margin-start);
  margin-right: var(--toast-button-margin-end);
}
[data-sonner-toast][data-styled=true] [data-cancel] {
  color: var(--normal-text);
  background: rgba(0, 0, 0, 0.08);
}
[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-styled=true] [data-cancel] {
  background: rgba(255, 255, 255, 0.3);
}
[data-sonner-toast][data-styled=true] [data-close-button] {
  position: absolute;
  left: var(--toast-close-button-start);
  right: var(--toast-close-button-end);
  top: 0;
  height: 20px;
  width: 20px;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0;
  color: var(--normal-text);
  background: var(--normal-bg);
  border: 1px solid var(--normal-border);
  transform: var(--toast-close-button-transform);
  border-radius: 50%;
  cursor: pointer;
  z-index: 1;
  transition:
    opacity 100ms,
    background 200ms,
    border-color 200ms;
}
[data-sonner-toast][data-styled=true] [data-close-button]:focus-visible {
  box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1), 0 0 0 2px rgba(0, 0, 0, 0.2);
}
[data-sonner-toast][data-styled=true] [data-disabled=true] {
  cursor: not-allowed;
}
[data-sonner-toast][data-styled=true]:hover [data-close-button]:hover {
  background: var(--gray2);
  border-color: var(--gray5);
}
[data-sonner-toast][data-swiping=true]::before {
  content: "";
  position: absolute;
  left: -100%;
  right: -100%;
  height: 100%;
  z-index: -1;
}
[data-sonner-toast][data-y-position=top][data-swiping=true]::before {
  bottom: 50%;
  transform: scaleY(3) translateY(50%);
}
[data-sonner-toast][data-y-position=bottom][data-swiping=true]::before {
  top: 50%;
  transform: scaleY(3) translateY(-50%);
}
[data-sonner-toast][data-swiping=false][data-removed=true]::before {
  content: "";
  position: absolute;
  inset: 0;
  transform: scaleY(2);
}
[data-sonner-toast][data-expanded=true]::after {
  content: "";
  position: absolute;
  left: 0;
  height: calc(var(--gap) + 1px);
  bottom: 100%;
  width: 100%;
}
[data-sonner-toast][data-mounted=true] {
  --y: translateY(0);
  opacity: 1;
}
[data-sonner-toast][data-expanded=false][data-front=false] {
  --scale: var(--toasts-before) * 0.05 + 1;
  --y: translateY(calc(var(--lift-amount) * var(--toasts-before))) scale(calc(-1 * var(--scale)));
  height: var(--front-toast-height);
}
[data-sonner-toast] > * {
  transition: opacity 400ms;
}
[data-sonner-toast][data-x-position=right] {
  right: 0;
}
[data-sonner-toast][data-x-position=left] {
  left: 0;
}
[data-sonner-toast][data-expanded=false][data-front=false][data-styled=true] > * {
  opacity: 0;
}
[data-sonner-toast][data-visible=false] {
  opacity: 0;
  pointer-events: none;
}
[data-sonner-toast][data-mounted=true][data-expanded=true] {
  --y: translateY(calc(var(--lift) * var(--offset)));
  height: var(--initial-height);
}
[data-sonner-toast][data-removed=true][data-front=true][data-swipe-out=false] {
  --y: translateY(calc(var(--lift) * -100%));
  opacity: 0;
}
[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=true] {
  --y: translateY(calc(var(--lift) * var(--offset) + var(--lift) * -100%));
  opacity: 0;
}
[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=false] {
  --y: translateY(40%);
  opacity: 0;
  transition: transform 500ms, opacity 200ms;
}
[data-sonner-toast][data-removed=true][data-front=false]::before {
  height: calc(var(--initial-height) + 20%);
}
[data-sonner-toast][data-swiping=true] {
  transform: var(--y) translateY(var(--swipe-amount-y, 0px)) translateX(var(--swipe-amount-x, 0px));
  transition: none;
}
[data-sonner-toast][data-swiped=true] {
  -webkit-user-select: none;
  user-select: none;
}
[data-sonner-toast][data-swipe-out=true][data-y-position=bottom],
[data-sonner-toast][data-swipe-out=true][data-y-position=top] {
  animation-duration: 200ms;
  animation-timing-function: ease-out;
  animation-fill-mode: forwards;
}
[data-sonner-toast][data-swipe-out=true][data-swipe-direction=left] {
  animation-name: swipe-out-left;
}
[data-sonner-toast][data-swipe-out=true][data-swipe-direction=right] {
  animation-name: swipe-out-right;
}
[data-sonner-toast][data-swipe-out=true][data-swipe-direction=up] {
  animation-name: swipe-out-up;
}
[data-sonner-toast][data-swipe-out=true][data-swipe-direction=down] {
  animation-name: swipe-out-down;
}
@keyframes swipe-out-left {
  from {
    transform: var(--y) translateX(var(--swipe-amount-x));
    opacity: 1;
  }
  to {
    transform: var(--y) translateX(calc(var(--swipe-amount-x) - 100%));
    opacity: 0;
  }
}
@keyframes swipe-out-right {
  from {
    transform: var(--y) translateX(var(--swipe-amount-x));
    opacity: 1;
  }
  to {
    transform: var(--y) translateX(calc(var(--swipe-amount-x) + 100%));
    opacity: 0;
  }
}
@keyframes swipe-out-up {
  from {
    transform: var(--y) translateY(var(--swipe-amount-y));
    opacity: 1;
  }
  to {
    transform: var(--y) translateY(calc(var(--swipe-amount-y) - 100%));
    opacity: 0;
  }
}
@keyframes swipe-out-down {
  from {
    transform: var(--y) translateY(var(--swipe-amount-y));
    opacity: 1;
  }
  to {
    transform: var(--y) translateY(calc(var(--swipe-amount-y) + 100%));
    opacity: 0;
  }
}
@media (max-width: 600px) {
  [data-sonner-toaster] {
    position: fixed;
    right: var(--mobile-offset-right);
    left: var(--mobile-offset-left);
    width: 100%;
  }
  [data-sonner-toaster][dir=rtl] {
    left: calc(var(--mobile-offset-left) * -1);
  }
  [data-sonner-toaster] [data-sonner-toast] {
    left: 0;
    right: 0;
    width: calc(100% - var(--mobile-offset-left) * 2);
  }
  [data-sonner-toaster][data-x-position=left] {
    left: var(--mobile-offset-left);
  }
  [data-sonner-toaster][data-y-position=bottom] {
    bottom: var(--mobile-offset-bottom);
  }
  [data-sonner-toaster][data-y-position=top] {
    top: var(--mobile-offset-top);
  }
  [data-sonner-toaster][data-x-position=center] {
    left: var(--mobile-offset-left);
    right: var(--mobile-offset-right);
    transform: none;
  }
}
[data-sonner-toaster][data-sonner-theme=light] {
  --normal-bg: #fff;
  --normal-border: var(--gray4);
  --normal-text: var(--gray12);
  --success-bg: hsl(143, 85%, 96%);
  --success-border: hsl(145, 92%, 87%);
  --success-text: hsl(140, 100%, 27%);
  --info-bg: hsl(208, 100%, 97%);
  --info-border: hsl(221, 91%, 93%);
  --info-text: hsl(210, 92%, 45%);
  --warning-bg: hsl(49, 100%, 97%);
  --warning-border: hsl(49, 91%, 84%);
  --warning-text: hsl(31, 92%, 45%);
  --error-bg: hsl(359, 100%, 97%);
  --error-border: hsl(359, 100%, 94%);
  --error-text: hsl(360, 100%, 45%);
}
[data-sonner-toaster][data-sonner-theme=light] [data-sonner-toast][data-invert=true] {
  --normal-bg: #000;
  --normal-border: hsl(0, 0%, 20%);
  --normal-text: var(--gray1);
}
[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-invert=true] {
  --normal-bg: #fff;
  --normal-border: var(--gray3);
  --normal-text: var(--gray12);
}
[data-sonner-toaster][data-sonner-theme=dark] {
  --normal-bg: #000;
  --normal-bg-hover: hsl(0, 0%, 12%);
  --normal-border: hsl(0, 0%, 20%);
  --normal-border-hover: hsl(0, 0%, 25%);
  --normal-text: var(--gray1);
  --success-bg: hsl(150, 100%, 6%);
  --success-border: hsl(147, 100%, 12%);
  --success-text: hsl(150, 86%, 65%);
  --info-bg: hsl(215, 100%, 6%);
  --info-border: hsl(223, 43%, 17%);
  --info-text: hsl(216, 87%, 65%);
  --warning-bg: hsl(64, 100%, 6%);
  --warning-border: hsl(60, 100%, 9%);
  --warning-text: hsl(46, 87%, 65%);
  --error-bg: hsl(358, 76%, 10%);
  --error-border: hsl(357, 89%, 16%);
  --error-text: hsl(358, 100%, 81%);
}
[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button] {
  background: var(--normal-bg);
  border-color: var(--normal-border);
  color: var(--normal-text);
}
[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button]:hover {
  background: var(--normal-bg-hover);
  border-color: var(--normal-border-hover);
}
[data-rich-colors=true][data-sonner-toast][data-type=success] {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=success] [data-close-button] {
  background: var(--success-bg);
  border-color: var(--success-border);
  color: var(--success-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=info] {
  background: var(--info-bg);
  border-color: var(--info-border);
  color: var(--info-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=info] [data-close-button] {
  background: var(--info-bg);
  border-color: var(--info-border);
  color: var(--info-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=warning] {
  background: var(--warning-bg);
  border-color: var(--warning-border);
  color: var(--warning-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=warning] [data-close-button] {
  background: var(--warning-bg);
  border-color: var(--warning-border);
  color: var(--warning-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=error] {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-text);
}
[data-rich-colors=true][data-sonner-toast][data-type=error] [data-close-button] {
  background: var(--error-bg);
  border-color: var(--error-border);
  color: var(--error-text);
}
.sonner-loading-wrapper {
  --size: 16px;
  height: var(--size);
  width: var(--size);
  position: absolute;
  inset: 0;
  z-index: 10;
}
.sonner-loading-wrapper[data-visible=false] {
  transform-origin: center;
  animation: sonner-fade-out 0.2s ease forwards;
}
.sonner-spinner {
  position: relative;
  top: 50%;
  left: 50%;
  height: var(--size);
  width: var(--size);
}
.sonner-loading-bar {
  animation: sonner-spin 1.2s linear infinite;
  background: var(--gray11);
  border-radius: 6px;
  height: 8%;
  left: -10%;
  position: absolute;
  top: -3.9%;
  width: 24%;
}
.sonner-loading-bar:nth-child(1) {
  animation-delay: -1.2s;
  transform: rotate(0.0001deg) translate(146%);
}
.sonner-loading-bar:nth-child(2) {
  animation-delay: -1.1s;
  transform: rotate(30deg) translate(146%);
}
.sonner-loading-bar:nth-child(3) {
  animation-delay: -1s;
  transform: rotate(60deg) translate(146%);
}
.sonner-loading-bar:nth-child(4) {
  animation-delay: -0.9s;
  transform: rotate(90deg) translate(146%);
}
.sonner-loading-bar:nth-child(5) {
  animation-delay: -0.8s;
  transform: rotate(120deg) translate(146%);
}
.sonner-loading-bar:nth-child(6) {
  animation-delay: -0.7s;
  transform: rotate(150deg) translate(146%);
}
.sonner-loading-bar:nth-child(7) {
  animation-delay: -0.6s;
  transform: rotate(180deg) translate(146%);
}
.sonner-loading-bar:nth-child(8) {
  animation-delay: -0.5s;
  transform: rotate(210deg) translate(146%);
}
.sonner-loading-bar:nth-child(9) {
  animation-delay: -0.4s;
  transform: rotate(240deg) translate(146%);
}
.sonner-loading-bar:nth-child(10) {
  animation-delay: -0.3s;
  transform: rotate(270deg) translate(146%);
}
.sonner-loading-bar:nth-child(11) {
  animation-delay: -0.2s;
  transform: rotate(300deg) translate(146%);
}
.sonner-loading-bar:nth-child(12) {
  animation-delay: -0.1s;
  transform: rotate(330deg) translate(146%);
}
@keyframes sonner-fade-in {
  0% {
    opacity: 0;
    transform: scale(0.8);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes sonner-fade-out {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.8);
  }
}
@keyframes sonner-spin {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0.15;
  }
}
@media (prefers-reduced-motion) {
  [data-sonner-toast],
  [data-sonner-toast] > *,
  .sonner-loading-bar {
    transition: none !important;
    animation: none !important;
  }
}
.sonner-loader {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  transform-origin: center;
  transition: opacity 200ms, transform 200ms;
}
.sonner-loader[data-visible=false] {
  opacity: 0;
  transform: scale(0.8) translate(-50%, -50%);
}
`);var B=Array(12).fill(0);function se(e){return(()=>{var t=O(),n=t.firstChild;return g(n,u(c,{each:B,children:(e,t)=>(()=>{var e=k();return f(()=>_(e,`data-index`,t())),e})()})),f(n=>{var r=[`sonner-loading-wrapper`,e.class??e.className].filter(Boolean).join(` `),i=e.visible;return r!==n.e&&h(t,n.e=r),i!==n.t&&_(t,`data-visible`,n.t=i),n},{e:void 0,t:void 0}),t})()}function ce(){return A()}function le(){return j()}function V(){return M()}function H(){return N()}function ue(e){switch(e){case`success`:return u(ce,{});case`info`:return u(V,{});case`warning`:return u(le,{});case`error`:return u(H,{});default:return null}}function de(){return P()}function fe(){let[e,n]=a(typeof document<`u`&&document.hidden);return t(()=>{let e=()=>{n(document.hidden)};document.addEventListener(`visibilitychange`,e),i(()=>{document.removeEventListener(`visibilitychange`,e)})}),e}var U=1,pe=class{subscribers;toasts;dismissedToasts;constructor(){this.subscribers=[],this.toasts=[],this.dismissedToasts=new Set}subscribe=e=>(this.subscribers.push(e),()=>{let t=this.subscribers.indexOf(e);this.subscribers.splice(t,1)});publish=e=>{this.subscribers.forEach(t=>t(e))};addToast=e=>{this.publish(e),this.toasts=[...this.toasts,e]};create=e=>{let{message:t,...n}=e,r=typeof e.id==`string`&&e.id.length>0,i=typeof e.id==`number`||r?e.id:U++,a=this.toasts.find(e=>e.id===i),o=e.dismissible===void 0||e.dismissible;return this.dismissedToasts.has(i)&&this.dismissedToasts.delete(i),a?this.toasts=this.toasts.map(n=>n.id===i?(this.publish({...n,...e,id:i,title:t,dismissible:o}),{...n,...e,id:i,dismissible:o,title:t}):n):this.addToast({title:t,...n,dismissible:o,id:i}),i};dismiss=e=>(e?(this.dismissedToasts.add(e),requestAnimationFrame(()=>{this.subscribers.forEach(t=>t({id:e,dismiss:!0}))})):this.toasts.forEach(e=>{this.dismissedToasts.add(e.id),this.subscribers.forEach(t=>t({id:e.id,dismiss:!0}))}),e);message=(e,t)=>this.create({...t,message:e});error=(e,t)=>this.create({...t,message:e,type:`error`});success=(e,t)=>this.create({...t,type:`success`,message:e});info=(e,t)=>this.create({...t,type:`info`,message:e});warning=(e,t)=>this.create({...t,type:`warning`,message:e});loading=(e,t)=>this.create({...t,type:`loading`,message:e});promise=(e,t)=>{if(!t)return;let n;t.loading!==void 0&&(n=this.create({...t,promise:e,type:`loading`,message:t.loading,description:typeof t.description==`function`?void 0:t.description}));let r=Promise.resolve(typeof e==`function`?e():e),i=n!==void 0,a,o=r.then(async e=>{if(a=[`resolve`,e],he(e))i=!1,this.create({id:n,type:`default`,message:e});else if(me(e)&&!e.ok){i=!1;let r=typeof t.error==`function`?await t.error(`HTTP error! status: ${e.status}`):t.error,a=typeof t.description==`function`?await t.description(`HTTP error! status: ${e.status}`):t.description,o=W(r)?r:{message:r};this.create({id:n,type:`error`,description:a,...o})}else if(e instanceof Error){i=!1;let r=typeof t.error==`function`?await t.error(e):t.error,a=typeof t.description==`function`?await t.description(e):t.description,o=W(r)?r:{message:r};this.create({id:n,type:`error`,description:a,...o})}else if(t.success!==void 0){i=!1;let r=typeof t.success==`function`?await t.success(e):t.success,a=typeof t.description==`function`?await t.description(e):t.description,o=W(r)?r:{message:r};this.create({id:n,type:`success`,description:a,...o})}}).catch(async e=>{if(a=[`reject`,e],t.error!==void 0){i=!1;let r=typeof t.error==`function`?await t.error(e):t.error,a=typeof t.description==`function`?await t.description(e):t.description,o=W(r)?r:{message:r};this.create({id:n,type:`error`,description:a,...o})}}).finally(()=>{i&&(this.dismiss(n),n=void 0),t.finally?.()}),s=()=>new Promise((e,t)=>{o.then(()=>{a[0]===`reject`?t(a[1]):e(a[1])}).catch(t)});return typeof n!=`string`&&typeof n!=`number`?{unwrap:s}:Object.assign(n,{unwrap:s})};custom=(e,t)=>{let n=t?.id||U++;return this.create({jsx:e(n),...t,id:n}),n};getActiveToasts=()=>this.toasts.filter(e=>!this.dismissedToasts.has(e.id))};function me(e){return e&&typeof e==`object`&&`ok`in e&&typeof e.ok==`boolean`&&`status`in e&&typeof e.status==`number`}function W(e){return typeof e==`object`&&!!e&&`message`in e}function he(e){return typeof Node<`u`&&e instanceof Node}var G=new pe;function ge(e,t){let n=t?.id||U++;return G.addToast({title:e,...t,id:n}),n}var K=Object.assign(ge,{success:G.success,info:G.info,warning:G.warning,error:G.error,custom:G.custom,message:G.message,promise:G.promise,dismiss:G.dismiss,loading:G.loading},{getHistory:()=>G.toasts,getToasts:()=>G.getActiveToasts()});function _e(e){return typeof e==`object`&&!!e&&`label`in e}var ve=3,q=`24px`,J=`16px`,ye=4e3,be=14,xe=45,Se=200;function Y(...e){return e.filter(Boolean).join(` `)}function X(e){return typeof e==`function`?e():e}function Ce(e){let[t,n]=e.split(`-`),r=[];return t&&r.push(t),n&&r.push(n),r}function we(){if(typeof window>`u`||typeof document>`u`)return`ltr`;let e=document.documentElement.getAttribute(`dir`);return e===`auto`||!e?window.getComputedStyle(document.documentElement).direction:e}function Te(e,t){let n={};return[e,t].forEach((e,t)=>{let r=t===1,i=r?`--mobile-offset`:`--offset`,a=r?J:q,o=e=>{for(let t of[`top`,`right`,`bottom`,`left`])n[`${i}-${t}`]=typeof e==`number`?`${e}px`:e};if(typeof e==`number`||typeof e==`string`)o(e);else if(typeof e==`object`&&e)for(let t of[`top`,`right`,`bottom`,`left`]){let r=e[t];n[`${i}-${t}`]=r===void 0?a:typeof r==`number`?`${r}px`:r}else o(a)}),n}function Ee(e,t){return e??t}function De(e,t){return e??t??``}function Oe(e,t){return e??t??``}function ke(e){return e===`system`?typeof window<`u`&&window.matchMedia(`(prefers-color-scheme: dark)`).matches?`dark`:`light`:e}function Ae(e){let[n,o]=a(!1),[s,c]=a(!1),[m,y]=a(!1),[ee,b]=a(!1),[C,w]=a(!1),[T,E]=a(null),[te,D]=a(null),[O,k]=a(0),[A,j]=a(0),M,N=null,P=0,oe=0,R=ye,[z,B]=a(null),ce=()=>e.index===0,le=()=>e.index+1<=e.visibleToasts,V=()=>e.toast.type,H=()=>e.toast.dismissible!==!1,U=()=>Ee(e.classNames,e.classes),pe=()=>Oe(e.className,e.class),me=()=>De(e.descriptionClassName,e.descriptionClass),W=()=>Oe(e.toast.className,e.toast.class),he=()=>De(e.toast.descriptionClassName,e.toast.descriptionClass),G=()=>Ee(e.toast.classNames,e.toast.classes),ge=()=>e.toast.closeButton??e.closeButton,K=()=>e.toast.duration??e.duration??ye,ve=()=>e.toast.invert??e.invert,q=()=>V()===`loading`,J=()=>e.swipeDirections??Ce(e.position),we=p(()=>e.position.split(`-`)[0]),Te=p(()=>e.position.split(`-`)[1]),ke=p(()=>Math.max(0,e.heights.findIndex(t=>t.toastId===e.toast.id))),Ae=p(()=>e.heights.reduce((e,t,n)=>n>=ke()?e:e+t.height,0)),Z=p(()=>ke()*(e.gap??be)+Ae()),je=fe();d(()=>{R=K()});function Q(){c(!0),k(Z()),e.setHeights(t=>t.filter(t=>t.toastId!==e.toast.id)),window.setTimeout(()=>{e.removeToast(e.toast)},Se)}function Me(){return e.icons?.loading?(()=>{var t=F();return g(t,()=>e.icons.loading),f(e=>{var n=Y(U()?.loader,G()?.loader,`sonner-loader`),r=V()===`loading`;return n!==e.e&&h(t,e.e=n),r!==e.t&&_(t,`data-visible`,e.t=r),e},{e:void 0,t:void 0}),t})():u(se,{get class(){return Y(U()?.loader,G()?.loader)},get visible(){return V()===`loading`}})}let Ne=()=>e.toast.icon??e.icons?.[V()]??ue(V());return t(()=>{if(o(!0),!M)return;let t=M.getBoundingClientRect().height;j(t),e.setHeights(n=>[{toastId:e.toast.id,toasterId:e.toast.toasterId,height:t,position:e.toast.position},...n]),i(()=>{e.setHeights(t=>t.filter(t=>t.toastId!==e.toast.id))})}),d(()=>{if(!n()||!M)return;X(e.toast.title),X(e.toast.description);let t=M.style.height;M.style.height=`auto`;let r=M.getBoundingClientRect().height;M.style.height=t,j(r),e.setHeights(t=>t.find(t=>t.toastId===e.toast.id)?t.map(t=>t.toastId===e.toast.id?{...t,height:r}:t):[{toastId:e.toast.id,toasterId:e.toast.toasterId,height:r,position:e.toast.position},...t])}),d(r(()=>[e.expanded,e.interacting,e.toast,V(),je(),K()],([t,n,r,a])=>{if(r.promise&&a===`loading`||r.duration===1/0||a===`loading`)return;let o;t||n||(e.pauseWhenPageIsHidden??!0)&&je()?(()=>{if(oe<P){let e=new Date().getTime()-P;R-=e}oe=new Date().getTime()})():R!==1/0&&(P=new Date().getTime(),o=setTimeout(()=>{r.onAutoClose?.(r),Q()},R)),i(()=>{o&&clearTimeout(o)})})),d(r(()=>e.toast.delete,t=>{t&&(Q(),e.toast.onDismiss?.(e.toast))})),(()=>{var t=re(),r=t.firstChild,i=r.firstChild;t.$$pointermove=e=>{if(!z()||!H()||(window.getSelection()?.toString().length??0)>0)return;let t=e.clientY-z().y,n=e.clientX-z().x;!T()&&(Math.abs(n)>1||Math.abs(t)>1)&&E(Math.abs(n)>Math.abs(t)?`x`:`y`);let r={x:0,y:0},i=e=>1/(1.5+Math.abs(e)/20);T()===`y`?(J().includes(`top`)||J().includes(`bottom`))&&(r.y=J().includes(`top`)&&t<0||J().includes(`bottom`)&&t>0?t:t*i(t)):T()===`x`&&(J().includes(`left`)||J().includes(`right`))&&(r.x=J().includes(`left`)&&n<0||J().includes(`right`)&&n>0?n:n*i(n)),(Math.abs(r.x)>0||Math.abs(r.y)>0)&&w(!0),M?.style.setProperty(`--swipe-amount-x`,`${r.x}px`),M?.style.setProperty(`--swipe-amount-y`,`${r.y}px`)},t.$$pointerup=()=>{if(ee()||!H())return;B(null);let t=Number(M?.style.getPropertyValue(`--swipe-amount-x`).replace(`px`,``)||0),n=Number(M?.style.getPropertyValue(`--swipe-amount-y`).replace(`px`,``)||0),r=Math.max(1,new Date().getTime()-(N?.getTime()??0)),i=T()===`x`?t:n,a=Math.abs(i)/r;Math.abs(i)>=xe||a>.11?(k(Z()),e.toast.onDismiss?.(e.toast),T()===`x`?D(t>0?`right`:`left`):D(n>0?`down`:`up`),Q(),b(!0)):(M?.style.setProperty(`--swipe-amount-x`,`0px`),M?.style.setProperty(`--swipe-amount-y`,`0px`),w(!1),y(!1),E(null))},t.$$pointerdown=e=>{e.button!==2&&!q()&&H()&&(e.target.closest(`button`)||(N=new Date,k(Z()),e.currentTarget.setPointerCapture(e.pointerId),y(!0),B({x:e.clientX,y:e.clientY})))},t.addEventListener(`dragend`,()=>{y(!1),E(null),B(null)});var a=M;return typeof a==`function`?S(a,t):M=t,g(t,u(l,{get when(){return x(()=>!(!ge()||e.toast.jsx))()&&V()!==`loading`},get children(){var t=I();return t.$$click=()=>{!q()&&H()&&(Q(),e.toast.onDismiss?.(e.toast))},t.$$pointerup=e=>e.stopPropagation(),t.$$pointerdown=e=>e.stopPropagation(),g(t,()=>e.icons?.close??u(de,{})),f(n=>{var r=e.closeButtonAriaLabel??`Close toast`,i=q(),a=Y(U()?.closeButton,G()?.closeButton);return r!==n.e&&_(t,`aria-label`,n.e=r),i!==n.t&&_(t,`data-disabled`,n.t=i),a!==n.a&&h(t,n.a=a),n},{e:void 0,t:void 0,a:void 0}),t}}),r),g(t,u(l,{get when(){return x(()=>!!((V()||e.toast.icon||e.toast.promise)&&e.toast.icon!==null))()&&(e.icons?.[V()]!==null||e.toast.icon)},get children(){var t=ne();return g(t,(()=>{var t=x(()=>!!(e.toast.promise||e.toast.type===`loading`&&!e.toast.icon));return()=>t()?e.toast.icon||Me():null})(),null),g(t,(()=>{var t=x(()=>e.toast.type!==`loading`);return()=>t()?Ne():null})(),null),f(()=>h(t,Y(U()?.icon,G()?.icon))),t}}),r),g(i,(()=>{var t=x(()=>!!e.toast.jsx);return()=>t()?e.toast.jsx:X(e.toast.title)})()),g(r,u(l,{get when(){return e.toast.description},get children(){var t=L();return g(t,()=>X(e.toast.description)),f(()=>h(t,Y(me(),he(),U()?.description,G()?.description))),t}}),null),g(t,u(l,{get when(){return e.toast.cancel},children:t=>u(l,{get when(){return!_e(t())},get fallback(){return(()=>{var n=ie();return n.$$click=e=>{let n=t();H()&&(n.onClick?.(e),Q())},g(n,()=>t().label),f(t=>{var r=e.toast.cancelButtonStyle??e.cancelButtonStyle,i=Y(U()?.cancelButton,G()?.cancelButton);return t.e=v(n,r,t.e),i!==t.t&&h(n,t.t=i),t},{e:void 0,t:void 0}),n})()},get children(){return t()}})}),null),g(t,u(l,{get when(){return e.toast.action},children:t=>u(l,{get when(){return!_e(t())},get fallback(){return(()=>{var n=ae();return n.$$click=e=>{t().onClick?.(e),!e.defaultPrevented&&Q()},g(n,()=>t().label),f(t=>{var r=e.toast.actionButtonStyle??e.actionButtonStyle,i=Y(U()?.actionButton,G()?.actionButton);return t.e=v(n,r,t.e),i!==t.t&&h(n,t.t=i),t},{e:void 0,t:void 0}),n})()},get children(){return t()}})}),null),f(a=>{var o=Y(pe(),W(),U()?.toast,G()?.toast,U()?.default,U()?.[V()],G()?.[V()]),c=e.toast.richColors??e.defaultRichColors,l=!(e.toast.jsx||e.toast.unstyled||e.unstyled),u=n(),d=!!e.toast.promise,f=C(),p=s(),g=le(),y=we(),b=Te(),x=e.index,S=ce(),w=m(),T=H(),E=V(),D=ve(),k=ee(),j=te(),M=!!(e.expanded||e.expandByDefault&&n()),N=e.toast.testId,P={"--index":e.index,"--toasts-before":e.index,"--z-index":e.toasts.length-e.index,"--offset":`${s()?O():Z()}px`,"--initial-height":e.expandByDefault?`auto`:`${A()}px`,...e.style,...e.toast.style},F=Y(U()?.content,G()?.content),I=Y(U()?.title,G()?.title);return o!==a.e&&h(t,a.e=o),c!==a.t&&_(t,`data-rich-colors`,a.t=c),l!==a.a&&_(t,`data-styled`,a.a=l),u!==a.o&&_(t,`data-mounted`,a.o=u),d!==a.i&&_(t,`data-promise`,a.i=d),f!==a.n&&_(t,`data-swiped`,a.n=f),p!==a.s&&_(t,`data-removed`,a.s=p),g!==a.h&&_(t,`data-visible`,a.h=g),y!==a.r&&_(t,`data-y-position`,a.r=y),b!==a.d&&_(t,`data-x-position`,a.d=b),x!==a.l&&_(t,`data-index`,a.l=x),S!==a.u&&_(t,`data-front`,a.u=S),w!==a.c&&_(t,`data-swiping`,a.c=w),T!==a.w&&_(t,`data-dismissible`,a.w=T),E!==a.m&&_(t,`data-type`,a.m=E),D!==a.f&&_(t,`data-invert`,a.f=D),k!==a.y&&_(t,`data-swipe-out`,a.y=k),j!==a.g&&_(t,`data-swipe-direction`,a.g=j),M!==a.p&&_(t,`data-expanded`,a.p=M),N!==a.b&&_(t,`data-testid`,a.b=N),a.T=v(t,P,a.T),F!==a.A&&h(r,a.A=F),I!==a.O&&h(i,a.O=I),a},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0,r:void 0,d:void 0,l:void 0,u:void 0,c:void 0,w:void 0,m:void 0,f:void 0,y:void 0,g:void 0,p:void 0,b:void 0,T:void 0,A:void 0,O:void 0}),t})()}function Z(e){let r=n({position:`bottom-right`,hotkey:[`altKey`,`KeyT`],theme:`light`,gap:be,visibleToasts:ve,dir:we(),containerAriaLabel:`Notifications`},e),o=ke(r.theme),[s,m]=te({toasts:[]}),y=p(()=>{let e=s.toasts;return r.id?e.filter(e=>e.toasterId===r.id):e.filter(e=>!e.toasterId)}),ee=p(()=>Array.from(new Set([r.position,...y().filter(e=>e.position).map(e=>e.position)]))),[b,x]=a([]),[C,w]=a(!1),[D,O]=a(!1),[k,A]=a(o),[j,M]=a(null),[N,P]=a(!1),F,I=()=>r.hotkey.join(`+`).replace(/Key/g,``).replace(/Digit/g,``),ne=()=>Oe(r.className,r.class),L=()=>r.toastOptions,re=()=>Ee(L()?.classNames,L()?.classes),ie=()=>De(L()?.descriptionClassName,L()?.descriptionClass),ae=()=>Oe(L()?.className,L()?.class),z=e=>{m(`toasts`,t=>(t.find(t=>t.id===e.id)?.delete||G.dismiss(e.id),t.filter(({id:t})=>t!==e.id)))};return t(()=>{let e=G.subscribe(e=>{if(e.dismiss){requestAnimationFrame(()=>{m(`toasts`,T(t=>{t.forEach(t=>{t.id===e.id&&(t.delete=!0)})}))});return}let t=e,n=s.toasts.findIndex(e=>e.id===t.id);n===-1?m(`toasts`,T(e=>{e.unshift(t)})):m(`toasts`,n,E(t))});i(e)}),d(()=>{let e=r.theme;if(e!==`system`){A(e);return}if(typeof window>`u`)return;let t=window.matchMedia(`(prefers-color-scheme: dark)`),n=({matches:e})=>{A(e?`dark`:`light`)};n(t);try{t.addEventListener(`change`,n),i(()=>t.removeEventListener(`change`,n))}catch{t.addListener(n),i(()=>t.removeListener(n))}}),d(()=>{y().length<=1&&w(!1)}),t(()=>{let e=e=>{r.hotkey.length>0&&r.hotkey.every(t=>e[t]||e.code===t)&&(w(!0),F?.focus()),e.code===`Escape`&&(document.activeElement===F||F?.contains(document.activeElement))&&w(!1)};document.addEventListener(`keydown`,e),i(()=>document.removeEventListener(`keydown`,e))}),i(()=>{j()&&(j()?.focus({preventScroll:!0}),M(null),P(!1))}),(()=>{var e=oe();return g(e,u(c,{get each(){return ee()},children:(e,t)=>{let[n,i]=e.split(`-`),a=p(()=>y().filter(n=>!n.position&&t()===0||n.position===e)),o=p(()=>b().filter(n=>t()===0&&!n.position||n.position===e));return u(l,{get when(){return y().length>0},get children(){var t=R();t.$$pointerup=()=>O(!1),t.$$pointerdown=e=>{e.target instanceof HTMLElement&&e.target.dataset.dismissible===`false`||O(!0)},t.addEventListener(`dragend`,()=>w(!1)),t.addEventListener(`mouseleave`,()=>{D()||w(!1)}),t.$$mousemove=()=>w(!0),t.addEventListener(`mouseenter`,()=>w(!0)),t.addEventListener(`focus`,e=>{e.target instanceof HTMLElement&&e.target.dataset.dismissible===`false`||N()||(P(!0),M(e.relatedTarget))}),t.addEventListener(`blur`,e=>{N()&&!e.currentTarget.contains(e.relatedTarget)&&(P(!1),j()&&(j()?.focus({preventScroll:!0}),M(null)))});var s=F;return typeof s==`function`?S(s,t):F=t,_(t,`data-y-position`,n),_(t,`data-x-position`,i),g(t,u(c,{get each(){return a()},children:(t,n)=>u(Ae,{get icons(){return r.icons},get index(){return n()},toast:t,get defaultRichColors(){return r.richColors},get duration(){return L()?.duration??r.duration},get class(){return ae()},get descriptionClassName(){return ie()},get invert(){return!!r.invert},get visibleToasts(){return r.visibleToasts},get closeButton(){return L()?.closeButton??r.closeButton??!1},get interacting(){return D()},position:e,get style(){return L()?.style},get unstyled(){return L()?.unstyled},get classNames(){return re()},get cancelButtonStyle(){return L()?.cancelButtonStyle},get actionButtonStyle(){return L()?.actionButtonStyle},get closeButtonAriaLabel(){return L()?.closeButtonAriaLabel},removeToast:z,get toasts(){return a()},get heights(){return o()},setHeights:x,get expandByDefault(){return!!r.expand},get gap(){return r.gap},get expanded(){return C()},get swipeDirections(){return r.swipeDirections},get pauseWhenPageIsHidden(){return r.pauseWhenPageIsHidden}})})),f(e=>{var n=r.dir===`auto`?we():r.dir,i=ne(),a=k(),s={"--front-toast-height":`${o()[0]?.height??0}px`,"--gap":`${r.gap}px`,...r.style,...Te(r.offset,r.mobileOffset)};return n!==e.e&&_(t,`dir`,e.e=n),i!==e.t&&h(t,e.t=i),a!==e.a&&_(t,`data-sonner-theme`,e.a=a),e.o=v(t,s,e.o),e},{e:void 0,t:void 0,a:void 0,o:void 0}),t}})}})),f(()=>_(e,`aria-label`,r.customAriaLabel??`${r.containerAriaLabel} ${I()}`)),e})()}b([`pointerdown`,`pointerup`,`pointermove`,`click`,`mousemove`]);var je=2e3;function Q(e){return!e.description||e.description.length<=2e3?e:{...e,description:`${e.description.slice(0,je)}…`}}function Me(){return{nextId:0,entries:[]}}function Ne(e,t){if(t.type===`custom.shown`)return{state:{...e,nextId:e.nextId-1},effects:[]};if(t.type===`toast.released`)return{state:Fe(e,t.id),effects:[]};if(t.type===`toast.dismissed`)return{state:t.id===void 0?{nextId:e.nextId,entries:[]}:Fe(e,t.id),effects:[{type:`sonner.dismiss`,id:t.id}]};let n=e.entries.filter(e=>t.liveIds.has(e.id)),r=n.find(e=>e.key===t.key);if(r&&r.id===t.topmostLiveId)return{state:{nextId:e.nextId,entries:n.map(e=>e===r?{...e,options:t.options}:e)},id:r.id,effects:[{type:`sonner.publish`,id:r.id,options:t.options},{type:`dom.pulse`,id:r.id}]};let i=e.nextId-1;return{state:{nextId:i,entries:[...r?n.filter(e=>e!==r):n,{id:i,key:t.key,options:t.options}]},id:i,effects:[...r?[{type:`sonner.dismiss`,id:r.id}]:[],{type:`sonner.publish`,id:i,options:t.options}]}}function Pe(e,t){return e.entries.find(e=>e.id===t)?.options}function Fe(e,t){return e.entries.some(e=>e.id===t)?{nextId:e.nextId,entries:e.entries.filter(e=>e.id!==t)}:e}var Ie=m(`<div data-slot=toast-v2-icon>`),Le=m(`<div data-slot=toast-v2-content>`),Re=m(`<div data-slot=toast-v2-title>`),ze=m(`<div data-slot=toast-v2-description>`),Be=m(`<div data-slot=toast-v2-actions>`),Ve=m(`<button type=button data-slot=toast-v2-close-button>`),He=m(`<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M4.25 11.75L11.75 4.25"stroke=currentColor></path><path d="M11.75 11.75L4.25 4.25"stroke=currentColor>`),Ue=m(`<button type=button data-component=button-v2 data-size=small>`);function We(t){let r=w(),[a,o]=e(t,[`class`,`className`,`style`,`toastOptions`,`swipeDirections`]);return u(ee,{ref:e=>{e.setAttribute(`data-kb-top-layer`,``);let t=()=>{e.querySelectorAll(`.toast-v2-region .toast-v2`).forEach(e=>{let t=e.dataset.visible===`false`;e.inert=t,e.tabIndex=t?-1:0})},n=new MutationObserver(t);n.observe(e,{subtree:!0,childList:!0,attributes:!0,attributeFilter:[`data-visible`]}),t(),i(()=>n.disconnect())},get children(){return u(Z,n({get position(){return C(r.locale())?`bottom-left`:`bottom-right`},get offset(){return C(r.locale())?{left:32,bottom:48}:{right:32,bottom:48}},mobileOffset:16,gap:12,duration:5e3,swipeDirections:[`bottom`],get className(){return[`toast-v2-region`,a.className,a.class].filter(Boolean).join(` `)},get style(){return{"--width":`320px`,...a.style}},get toastOptions(){return{...a.toastOptions,unstyled:!0,closeButton:!0,closeButtonAriaLabel:a.toastOptions?.closeButtonAriaLabel??r.t(`ui.common.dismiss`)}}},o))}})}var Ge=s();function Ke(e){return u(Ge.Provider,{get value(){return e.toastId},get children(){return e.children}})}function qe(e){return(()=>{var t=Ie();return y(t,e,!1,!1),t})()}function Je(e){return(()=>{var t=Le();return y(t,e,!1,!1),t})()}function Ye(e){return(()=>{var t=Re();return y(t,e,!1,!1),t})()}function Xe(e){return(()=>{var t=ze();return y(t,e,!1,!1),t})()}function Ze(e){return(()=>{var t=Be();return y(t,e,!1,!1),t})()}function Qe(t){let r=w(),i=o(Ge),[a,s]=e(t,[`children`,`onClick`]);return(()=>{var e=Ve();return y(e,n({get"aria-label"(){return r.t(`ui.common.dismiss`)}},s,{onClick:e=>{a.onClick instanceof Function&&a.onClick(e),!e.defaultPrevented&&i!==void 0&&tt.dismiss(i)}}),!1,!0),g(e,()=>a.children??u($e,{})),e})()}function $e(){return He()}var et=Object.assign(Ke,{Region:We,Icon:qe,Content:Je,Title:Ye,Description:Xe,Actions:Ze,CloseButton:Qe}),tt={show(e,t){nt({type:`custom.shown`});let n=$.nextId;return K.custom(t=>e({toastId:Number(t)}),{id:n,className:`toast-v2`,duration:t?.persistent?1/0:t?.duration,unstyled:!0,description:t?.resize?()=>{t.resize?.()}:void 0}),n},dismiss(e){return nt({type:`toast.dismissed`,id:e}),e}},$=Me();function nt(e){rt(Ne($,e))}function rt(e){return $=e.state,e.effects.forEach(e=>{if(e.type===`sonner.publish`)return at(e.id,e.options);if(e.type===`sonner.dismiss`)return K.dismiss(e.id);st(e.id)}),e}function it(e){let t=Q(typeof e==`string`?{description:e}:e),n=JSON.stringify({title:t.title,description:t.description,variant:t.variant,duration:t.duration,persistent:t.persistent,actions:t.actions?.map(e=>[e.label,e.variant])}),r=K.getToasts();return rt(Ne($,{type:`toast.shown`,key:n,options:t,liveIds:new Set(r.map(e=>e.id)),topmostLiveId:r.at(-1)?.id})).id}function at(e,t){let n=()=>void nt({type:`toast.released`,id:e});K.message(t.title??``,{id:e,description:t.description,icon:t.icon,action:ot(e,t.actions),closeButton:!0,duration:t.persistent?1/0:t.duration,className:`toast-v2 toast-v2--${t.variant??`default`}`,testId:`toast-v2-${e}`,unstyled:!0,onDismiss:()=>{let t=Pe($,e);n(),t?.onDismiss?.()},onAutoClose:n})}function ot(e,t){if(t?.length)return u(et.Actions,{get children(){return t.map((t,n)=>(()=>{var r=Ue();return r.$$click=()=>{let t=Pe($,e);if(!t)return;let r=t.actions?.[n]?.onClick;r&&r!==`dismiss`&&r(),tt.dismiss(e)},g(r,()=>t.label),f(e=>{var n=t.variant===`secondary`?`ghost`:`neutral`,i=t.variant??`primary`;return n!==e.e&&_(r,`data-variant`,e.e=n),i!==e.t&&_(r,`data-action-variant`,e.t=i),e},{e:void 0,t:void 0}),r})())}})}function st(e){typeof document<`u`&&typeof requestAnimationFrame<`u`&&requestAnimationFrame(()=>{let t=document.querySelector(`[data-testid="toast-v2-${e}"]`);t&&!D()&&t.animate([{scale:1},{scale:1.025},{scale:1}],{duration:160,easing:`ease-out`})})}b([`click`]);export{it as n,tt as r,et as t};