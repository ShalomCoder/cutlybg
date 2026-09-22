export type ModelKind = "modnet" | "isnet";

export interface OnnxModel {
  id: ModelKind;
  name: string;
  tagline: string;
  downloadLabel: string;
  cachedLabel: string;
  url: string;
  sizeBytes: number;
  sizeLabel: string;
  inputSize: number;
}

export const MODELS: Record<ModelKind, OnnxModel> = {
  modnet: {
    id: "modnet",
    name: "MODNet",
    tagline: "Fast, portrait-focused",
    downloadLabel: "Fast cutout · ~6 MB",
    cachedLabel: "Fast cutout ready",
    url: "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_quantized.onnx",
    sizeBytes: 6_632_188,
    sizeLabel: "6 MB",
    inputSize: 512,
  },
  isnet: {
    id: "isnet",
    name: "ISNet",
    tagline: "High quality for hair and objects",
    downloadLabel: "Better cutout for hair & objects · 84 MB one-time",
    cachedLabel: "HD model ready",
    url: "https://huggingface.co/imgly/isnet-general-onnx/resolve/main/onnx/model_fp16.onnx",
    sizeBytes: 88_152_708,
    sizeLabel: "84 MB",
    inputSize: 1024,
  },
};