import type { CloudTexture } from './cloudTexture'
import { fogFragment, fogVertex, starFragment, starVertex } from './shaders'
import { createStars, type SkyFrame } from './sceneData'

export interface SkyRenderer {
  cloud(texture: CloudTexture): void
  draw(frame: SkyFrame): void
  dispose(): void
}

/** Three GPU batches: distant stars, the warped cloud textures, foreground stars. */
export function createSkyRenderer(canvas: HTMLCanvasElement): SkyRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
  if (!gl) return null
  const buffers: WebGLBuffer[] = [], programs: WebGLProgram[] = [], textures: WebGLTexture[] = []
  const dispose = () => {
    buffers.forEach(buffer => gl.deleteBuffer(buffer))
    programs.forEach(program => gl.deleteProgram(program))
    textures.forEach(texture => gl.deleteTexture(texture))
  }
  function program(vertex: string, fragment: string) {
    const shaders: WebGLShader[] = []
    try {
      for (const [type, source] of [[gl!.VERTEX_SHADER, vertex], [gl!.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl!.createShader(type)
        if (!shader) throw new Error('Could not allocate an ambient shader')
        shaders.push(shader); gl!.shaderSource(shader, source); gl!.compileShader(shader)
        if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) ?? 'Could not compile an ambient shader')
      }
      const result = gl!.createProgram()
      if (!result) throw new Error('Could not allocate the ambient program')
      programs.push(result)
      shaders.forEach(shader => gl!.attachShader(result, shader)); gl!.linkProgram(result)
      if (!gl!.getProgramParameter(result, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(result) ?? 'Could not link the ambient program')
      const uniform = (name: string) => gl!.getUniformLocation(result, name)
      return { program: result, size: uniform('uSize'), dpr: uniform('uDpr'), time: uniform('uTime'), intensity: uniform('uIntensity'), colors: uniform('uColors[0]'), occlusion: uniform('uOcclusion'), highlight: uniform('uHighlight') }
    } finally { shaders.forEach(shader => gl!.deleteShader(shader)) }
  }
  try {
    const stars = createStars(), farCount = stars.filter(star => star.depth === 1).length
    const points = program(starVertex, starFragment), fog = program(fogVertex, fogFragment)
    function buffer(values: Float32Array) {
      const result = gl!.createBuffer()
      if (!result) throw new Error('Could not allocate an ambient buffer')
      buffers.push(result); gl!.bindBuffer(gl!.ARRAY_BUFFER, result); gl!.bufferData(gl!.ARRAY_BUFFER, values, gl!.STATIC_DRAW)
      return result
    }
    const starBuffer = buffer(new Float32Array(stars.flatMap(star => [star.x, star.y, star.radius, star.alpha, star.phase, star.color, star.depth, Number(star.core)])))
    const quadBuffer = buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]))
    const position = gl.getAttribLocation(points.program, 'aPosition'), details = gl.getAttribLocation(points.program, 'aDetails')
    const quadPosition = gl.getAttribLocation(fog.program, 'aPosition')
    const mainSampler = gl.getUniformLocation(fog.program, 'uMain'), detailSampler = gl.getUniformLocation(fog.program, 'uDetails')
    let ready = false
    function setUniforms(target: typeof points, frame: SkyFrame) {
      gl!.useProgram(target.program)
      gl!.uniform2f(target.size, frame.width, frame.height); gl!.uniform1f(target.dpr, frame.dpr)
      gl!.uniform1f(target.time, frame.time); gl!.uniform1f(target.intensity, frame.intensity)
      gl!.uniform3fv(target.colors, frame.palette.flat()); gl!.uniform4fv(target.occlusion, frame.occlusion)
      gl!.uniform1f(target.highlight, frame.highlight)
    }
    function bindStars() {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, starBuffer)
      gl!.enableVertexAttribArray(position); gl!.vertexAttribPointer(position, 4, gl!.FLOAT, false, 32, 0)
      gl!.enableVertexAttribArray(details); gl!.vertexAttribPointer(details, 4, gl!.FLOAT, false, 32, 16)
      gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA)
    }
    gl.enable(gl.BLEND)
    return {
      cloud(texture) {
        textures.forEach(value => gl.deleteTexture(value)); textures.length = 0
        for (const [index, pixels] of [texture.main, texture.details].entries()) {
          const value = gl.createTexture()
          if (!value) throw new Error('Could not allocate a nebula texture')
          textures.push(value); gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, value)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texture.width, texture.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        }
        ready = true
      },
      draw(frame) {
        const width = Math.round(frame.width * frame.dpr), height = Math.round(frame.height * frame.dpr)
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
        setUniforms(points, frame); bindStars(); gl.drawArrays(gl.POINTS, 0, farCount)
        if (ready) {
          setUniforms(fog, frame)
          gl.disableVertexAttribArray(position); gl.disableVertexAttribArray(details)
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer); gl.enableVertexAttribArray(quadPosition); gl.vertexAttribPointer(quadPosition, 2, gl.FLOAT, false, 0, 0)
          textures.forEach((texture, index) => { gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture) })
          gl.uniform1i(mainSampler, 0); gl.uniform1i(detailSampler, 1)
          gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
          gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(quadPosition)
          setUniforms(points, frame); bindStars()
        }
        gl.drawArrays(gl.POINTS, farCount, stars.length - farCount)
      },
      dispose
    }
  } catch (error) {
    dispose()
    console.warn('Could not start the accelerated sky renderer', error)
    return null
  }
}
