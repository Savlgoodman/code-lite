import { useEffect, type RefObject, type MutableRefObject } from "react";
import { VERT, FRAG_SIM, FRAG_BLUR, FRAG_COMP } from "./effortShaders";

/**
 * WebGL2 火焰渲染引擎（React 版，移植自 254558/claude-range-slider 的 Vue composable）。
 *
 * 通过 ref 读取滑块值与激活态，避免每帧触发 React 重渲染；到达 Ultracode
 * （activeRef=true）时渲染 4-pass 火焰，闲置 180 帧后自动停机。
 *
 * @param canvasRef 目标 canvas
 * @param sliderRef 归一化滑块值 0..1（填充比例）
 * @param activeRef 是否处于最高挡（驱动火焰启停）
 */
export function useWebglFire(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  sliderRef: MutableRefObject<number>,
  activeRef: MutableRefObject<boolean>,
  /** hook 会把"启动渲染循环"的函数写入此 ref，供组件在进入最高挡时调用 */
  kickRef: MutableRefObject<(() => void) | null>,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGL2RenderingContext | null = null;
    let rafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeDebounce: number | null = null;

    let loopRunning = false;
    let idleFrames = 0;
    let wasActive = false;
    let ultraStart: number | null = null;

    const MAX_IDLE = 180;

    let simProg: WebGLProgram | null = null;
    let blurProg: WebGLProgram | null = null;
    let compProg: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let vbo: WebGLBuffer | null = null;
    let programsReady = false;

    type FBO = { fbo: WebGLFramebuffer; tex: WebGLTexture };
    let simA: FBO | null = null;
    let simB: FBO | null = null;
    let blurH: FBO | null = null;
    let blurV: FBO | null = null;

    const U: Record<string, WebGLUniformLocation | null> = {};

    /* ── context event handlers ── */
    const onContextLost = (e: Event) => e.preventDefault();
    const onContextRestored = () => {
      programsReady = false;
      compilePrograms();
      if (programsReady) {
        resize();
        if (activeRef.current) ensureLoop();
      }
    };

    /* ── program compilation ── */
    function compileShader(type: number, src: string): WebGLShader | null {
      if (!gl) return null;
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }

    function linkProgram(vsSrc: string, fsSrc: string): WebGLProgram | null {
      if (!gl) return null;
      const v = compileShader(gl.VERTEX_SHADER, vsSrc);
      const f = compileShader(gl.FRAGMENT_SHADER, fsSrc);
      if (!v || !f) return null;
      const p = gl.createProgram();
      if (!p) return null;
      gl.attachShader(p, v);
      gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, "a_pos");
      gl.linkProgram(p);
      gl.deleteShader(v);
      gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(p));
        return null;
      }
      return p;
    }

    function compilePrograms() {
      if (!gl) return;
      simProg = linkProgram(VERT, FRAG_SIM);
      blurProg = linkProgram(VERT, FRAG_BLUR);
      compProg = linkProgram(VERT, FRAG_COMP);
      if (!simProg || !blurProg || !compProg) return;

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      U.simTime = gl.getUniformLocation(simProg, "u_time");
      U.simSlider = gl.getUniformLocation(simProg, "u_slider");
      U.simElapsed = gl.getUniformLocation(simProg, "u_elapsed");
      U.simBack = gl.getUniformLocation(simProg, "u_back");
      U.blurDir = gl.getUniformLocation(blurProg, "u_dir");
      U.blurExt = gl.getUniformLocation(blurProg, "u_ext");
      U.blurTex = gl.getUniformLocation(blurProg, "u_tex");
      U.blurRes = gl.getUniformLocation(blurProg, "u_res");
      U.compScene = gl.getUniformLocation(compProg, "u_scene");
      U.compGlow = gl.getUniformLocation(compProg, "u_glow");

      programsReady = true;
    }

    /* ── resize ── */
    function resize() {
      if (!gl || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      destroyFBOs();
      createFBOs();
    }

    /* ── FBO helpers ── */
    function makeFBO(): FBO | null {
      if (!gl || !canvas) return null;
      const fbo = gl.createFramebuffer();
      const tex = gl.createTexture();
      if (!fbo || !tex) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { fbo, tex };
    }

    function createFBOs() {
      if (!gl || !canvas) return;
      simA = makeFBO();
      simB = makeFBO();
      blurH = makeFBO();
      blurV = makeFBO();
    }

    function destroyFBO(entry: FBO | null) {
      if (!gl || !entry) return;
      gl.deleteFramebuffer(entry.fbo);
      gl.deleteTexture(entry.tex);
    }

    function destroyFBOs() {
      destroyFBO(simA); simA = null;
      destroyFBO(simB); simB = null;
      destroyFBO(blurH); blurH = null;
      destroyFBO(blurV); blurV = null;
    }

    function destroyPrograms() {
      if (!gl) return;
      if (simProg) { gl.deleteProgram(simProg); simProg = null; }
      if (blurProg) { gl.deleteProgram(blurProg); blurProg = null; }
      if (compProg) { gl.deleteProgram(compProg); compProg = null; }
      if (vao) { gl.deleteVertexArray(vao); vao = null; }
      if (vbo) { gl.deleteBuffer(vbo); vbo = null; }
      programsReady = false;
    }

    /* ── render loop ── */
    function ensureLoop() {
      if (!gl) return;
      if (!simA || !simB) {
        resize();
        if (!simA || !simB) return;
      }
      if (loopRunning) { idleFrames = 0; return; }
      loopRunning = true;
      idleFrames = 0;
      wasActive = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, simA.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, simB.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      rafId = requestAnimationFrame(render);
    }

    function render(t: number) {
      if (!gl || !canvas || !simA || !simB || !blurH || !blurV) { loopRunning = false; rafId = null; return; }
      const active = activeRef.current;

      if (!active && !wasActive) {
        if (++idleFrames > MAX_IDLE) { loopRunning = false; rafId = null; return; }
        rafId = requestAnimationFrame(render);
        return;
      }
      idleFrames = 0;

      if (active && !wasActive) {
        if (ultraStart == null) ultraStart = performance.now();
        gl.bindFramebuffer(gl.FRAMEBUFFER, simA.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, simB.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (!active) ultraStart = null;
      wasActive = active;

      const elapsed = active ? (performance.now() - (ultraStart || 0)) / 1000 : -1.0;
      const sv = sliderRef.current;

      gl.viewport(0, 0, canvas.width, canvas.height);

      // pass 1: simulation
      gl.bindFramebuffer(gl.FRAMEBUFFER, simB.fbo);
      gl.useProgram(simProg);
      gl.uniform1f(U.simTime, t * 0.001);
      gl.uniform1f(U.simSlider, sv);
      gl.uniform1f(U.simElapsed, elapsed);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, simA.tex);
      gl.uniform1i(U.simBack, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // pass 2: horizontal blur
      gl.useProgram(blurProg);
      gl.uniform2f(U.blurRes, canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurH.fbo);
      gl.uniform2f(U.blurDir, 1.0, 0.0);
      gl.uniform1f(U.blurExt, 1.0);
      gl.bindTexture(gl.TEXTURE_2D, simB.tex);
      gl.uniform1i(U.blurTex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // pass 3: vertical blur
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurV.fbo);
      gl.uniform2f(U.blurDir, 0.0, 1.0);
      gl.uniform1f(U.blurExt, 0.0);
      gl.bindTexture(gl.TEXTURE_2D, blurH.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // pass 4: composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, simB.tex);
      gl.uniform1i(U.compScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blurV.tex);
      gl.uniform1i(U.compGlow, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // ping-pong swap
      const tmp = simA; simA = simB; simB = tmp;

      rafId = requestAnimationFrame(render);
    }

    // ── init ──
    const ctx = canvas.getContext("webgl2", {
      preserveDrawingBuffer: false,
      antialias: false,
    });
    if (!ctx) {
      console.warn("WebGL2 not supported");
      return;
    }
    gl = ctx;
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    compilePrograms();
    if (programsReady) {
      resizeObserver = new ResizeObserver(() => {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = window.setTimeout(resize, 80);
      });
      resizeObserver.observe(canvas);
      resize();
      kickRef.current = ensureLoop;
      if (activeRef.current) ensureLoop();
    }

    // ── cleanup ──
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeObserver) resizeObserver.disconnect();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      loopRunning = false;
      destroyFBOs();
      destroyPrograms();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      kickRef.current = null;
      gl = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
