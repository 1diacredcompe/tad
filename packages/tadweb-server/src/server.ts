import * as express from "express";
import * as log from "loglevel";
import * as commandLineArgs from "command-line-args";
import { AddressInfo } from "net";
import * as path from "path";
import * as reltabSqlite from "reltab-sqlite";
import { SqliteContext } from "reltab-sqlite";
import { BigQueryConnection } from "reltab-bigquery";
import * as reltab from "reltab";
import { monitorEventLoopDelay } from "perf_hooks";
import { read } from "fs";

const SRV_DIR = "./public/csv";

const portNumber = 9000;

const initSqlite = async (): Promise<SqliteContext> => {
  const rtOptions: any = { showQueries: true };
  const ctx = (await reltabSqlite.getContext(
    ":memory:",
    rtOptions
  )) as SqliteContext;

  return ctx;
};

const handleEvalQuery = async (
  rtc: reltab.Connection,
  req: express.Request,
  res: express.Response
) => {
  try {
    log.debug(
      "POST evalQuery: got request: ",
      JSON.stringify(req.body, undefined, 2)
    );
    const queryReq = req.body;
    log.info("evalQuery: got query:\n", queryReq.query.toJS(), "\n\n");
    const hrstart = process.hrtime();
    const tableRep = await (queryReq.offset !== undefined
      ? rtc.evalQuery(queryReq.query, queryReq.offset, queryReq.limit)
      : rtc.evalQuery(queryReq.query));
    const [es, ens] = process.hrtime(hrstart);
    log.info("\nevalQuery: evaluated query in %ds %dms", es, ens / 1e6);
    const resObj = { tableRep };
    log.info(`sending response w/ ${tableRep.rowData.length} rows.\n`);
    res.json(resObj);
  } catch (err) {
    log.error("evalQuery: ", err, err.stack);
    // TODO: return an error
  }
};

const handleGetRowCount = async (
  rtc: reltab.Connection,
  req: express.Request,
  res: express.Response
) => {
  try {
    log.debug(
      "POST getRowcount: got request: ",
      JSON.stringify(req.body, undefined, 2)
    );
    const queryReq = req.body;
    const hrstart = process.hrtime();
    const rowCount = await rtc.rowCount(queryReq.query);
    const [es, ens] = process.hrtime(hrstart);
    log.info("getRowCount: evaluated query in %ds %dms", es, ens / 1e6);
    const resObj = { rowCount };
    log.info("sending response: ", resObj);
    res.json(resObj);
  } catch (err) {
    log.error("getRowCount: ", err, err.stack);
    // TODO: return an error
  }
};

// TODO: really should cache fileName to table name, so we don't have to re-import CSV file every time
const handleImportFile = async (
  rtc: reltab.Connection,
  req: express.Request,
  res: express.Response
) => {
  try {
    const ctx = rtc as SqliteContext;
    log.info("POST importFile: got request: ", req.body);
    const tiReq = req.body;
    // const tableInfo = await rtc.getTableInfo(tiReq.tableName);
    const { fileName } = tiReq;
    const filePath = path.join(SRV_DIR, fileName);
    log.info("handleImportFile: importing: " + filePath);

    const md = await reltabSqlite.fastImport(ctx.db, filePath);
    const ti = reltabSqlite.mkTableInfo(md);
    const tableName = ti.tableName;
    log.info("imported CSV, table name: ", tableName);
    ctx.registerTable(ti);
    const resObj = { tableName };
    log.info("getTableInfo: sending response: ", resObj);
    res.json(resObj);
  } catch (err) {
    log.error("importFile: ", err, err.stack);
  }
};

const handleGetTableInfo = async (
  rtc: reltab.Connection,
  req: express.Request,
  res: express.Response
) => {
  try {
    log.info("POST getTableInfo: got request: ", req.body);
    const tiReq = req.body;
    const tableInfo = await rtc.getTableInfo(tiReq.tableName);
    const resObj = { tableInfo };
    log.info(
      "getTableInfo: sending response: ",
      JSON.stringify(resObj, null, 2)
    );
    res.json(resObj);
  } catch (err) {
    log.error("getTableInfo: ", err, err.stack);
  }
};

const handleGetSourceInfo = async (
  rtc: reltab.Connection,
  req: express.Request,
  res: express.Response
) => {
  try {
    log.info("POST getSourceInfo: got request: ", req.body);
    const tiReq = req.body;
    const sourceInfo = await rtc.getSourceInfo(tiReq.path);
    const resObj = { sourceInfo };
    log.info(
      "getSourceInfo: sending response w/ node Id: ",
      JSON.stringify(sourceInfo.nodeId)
    );
    res.json(resObj);
  } catch (err) {
    log.error("getSourceInfo: ", err, err.stack);
  }
};

const viewerUrl = "/tadweb-app/index.html";

const rootRedirect = (req: express.Request, res: express.Response) => {
  res.redirect(viewerUrl);
};

async function main() {
  log.setLevel(log.levels.INFO);

  // const dbCtx = await initSqlite();
  const dbCtx = new BigQueryConnection(
    "bigquery-public-data",
    "covid19_jhu_csse",
    { showQueries: true }
  );

  const ti = await dbCtx.getTableInfo(
    "bigquery-public-data.covid19_jhu_csse.summary"
  );
  console.log("tableInfo: ", ti);

  const ti2 = await dbCtx.getTableInfo(
    "bigquery-public-data.github_repos.commits"
  );
  console.log("tableInfo: ", ti2);

  const ti3 = await dbCtx.getTableInfo(
    "bigquery-public-data.iowa_liquor_sales.sales"
  );
  console.log("tableInfo: ", ti3);

  log.info("db initialization complete");

  let app = express();
  app.use(express.json({ reviver: reltab.queryReviver }));

  // app.get("/", (req, res) => res.send("Hello World!"));
  app.get("/", rootRedirect);

  app.use(express.static("./public"));

  app.post("/tadweb/evalQuery", (req, res) => handleEvalQuery(dbCtx, req, res));

  app.post("/tadweb/getRowCount", (req, res) =>
    handleGetRowCount(dbCtx, req, res)
  );

  app.post("/tadweb/getTableInfo", (req, res) =>
    handleGetTableInfo(dbCtx, req, res)
  );

  app.post("/tadweb/importFile", (req, res) =>
    handleImportFile(dbCtx, req, res)
  );

  app.post("/tadweb/getSourceInfo", (req, res) =>
    handleGetSourceInfo(dbCtx, req, res)
  );

  const server = app.listen(portNumber, () => {
    const addr = server.address() as AddressInfo;
    log.info("Listening on port ", addr.port);
  });
}

main();
