export function shouldReportManagedOpenCodeProcess({
  backend,
  processHandle,
  port,
  skipStart = false,
  external = false,
}) {
  if (backend === 'pi') return false;
  return Boolean((processHandle || port) && !skipStart && !external);
}

