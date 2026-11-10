import { Failure } from "../shared/core.js";
export async function saveWithPermission({
  granted,
  origin,
  alreadyGranted,
  save,
  isUsed,
  remove,
}) {
  if (!(await granted))
    throw new Failure("PERMISSION_MISSING", "请允许访问所选翻译服务。");
  try {
    return await save();
  } catch (error) {
    if (!alreadyGranted) {
      try {
        if (!(await isUsed(origin)) && !(await remove(origin)))
          throw Error("permission cleanup refused");
      } catch {
        throw new Failure(
          "PERMISSION_CLEANUP_FAILED",
          "保存失败，新增授权未能安全清理，请在扩展权限中检查。",
        );
      }
    }
    throw error;
  }
}
