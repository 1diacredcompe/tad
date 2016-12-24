/* @flow */

import * as React from 'react'
import * as pivotRequest from '../pivotRequest'
import * as _ from 'lodash'
import { Slick } from 'slickgrid-es6'
import * as reltab from '../reltab'
import * as actions from '../actions'
import LoadingModal from './LoadingModal'

const container = '#epGrid' // for now

const gridOptions = {
  multiColumnSort: true
}

const INDENT_PER_LEVEL = 15 // pixels

const calcIndent = (depth: number): number => (INDENT_PER_LEVEL * depth)

/*
 * Formatter for cells in pivot column
 */
const groupCellFormatter = (row, cell, value, columnDef, item) => {
  const toggleCssClass = 'slick-group-toggle'
  const toggleExpandedCssClass = 'expanded'
  const toggleCollapsedCssClass = 'collapsed'
  const groupTitleCssClass = 'slick-group-title'

  var indentation = calcIndent(item._depth) + 'px'

  var pivotStr = item._pivot || ''

  var ret = "<span class='" + toggleCssClass + ' ' +
    ((!item._isLeaf) ? (item._isOpen ? toggleExpandedCssClass : toggleCollapsedCssClass) : '') +
    "' style='margin-left:" + indentation + "'>" +
    '</span>' +
    "<span class='" + groupTitleCssClass + "' level='" + item._depth + "'>" +
    pivotStr +
    '</span>'
  return ret
}

// scan table data to make best effort at initial column widths
const MINCOLWIDTH = 80
const MAXCOLWIDTH = 300

// TODO: use real font metrics:
const measureStringWidth = (s: string): number => 8 + (5.5 * s.length)

// get column width for specific column:
const getColWidth = (dataView: Object, cnm: string) => {
  let colWidth
  var nRows = dataView.getLength()
  for (var i = 0; i < nRows; i++) {
    var row = dataView.getItem(i)
    var cellVal = row[ cnm ]
    var cellWidth = MINCOLWIDTH
    if (cellVal) {
      cellWidth = measureStringWidth(cellVal.toString())
    }
    if (cnm === '_pivot') {
      cellWidth += calcIndent(row._depth + 2)
    }
    colWidth = Math.min(MAXCOLWIDTH,
      Math.max(colWidth || MINCOLWIDTH, cellWidth))
  }
  const headerStrWidth = measureStringWidth(dataView.schema.displayName(cnm))
  colWidth = Math.min(MAXCOLWIDTH,
    Math.max(colWidth || MINCOLWIDTH, headerStrWidth))
  return colWidth
}

type ColWidthMap = {[cid: string]: number}

function getInitialColWidthsMap (dataView: Object): ColWidthMap {
  // let's approximate the column width:
  var colWidths = {}
  var nRows = dataView.getLength()
  if (nRows === 0) {
    return {}
  }
  const initRow = dataView.getItem(0)
  for (let cnm in initRow) {
    colWidths[cnm] = getColWidth(dataView, cnm)
  }

  return colWidths
}

/*
 * Construct map of SlickGrid column descriptors from base schema
 * and column width info
 *
 * Map should contain entries for all column ids
 */
const mkSlickColMap = (schema: reltab.Schema, colWidths: ColWidthMap) => {
  let slickColMap = {}

  // hidden columns:
  slickColMap['_id'] = { id: '_id', field: '_id', name: '_id' }
  slickColMap['_parentId'] = { id: '_parentId', field: '_parentId', name: '_parentId' }
  for (let colId of schema.columns) {
    let cmd = schema.columnMetadata[ colId ]
    let ci: any = { id: colId, field: colId, cssClass: '', name: '', formatter: null }
    if (colId === '_pivot') {
      ci.cssClass = 'pivot-column'
      ci.name = ''
      ci.formatter = groupCellFormatter
    } else {
      var displayName = cmd.displayName || colId
      ci.name = displayName
      ci.toolTip = displayName
      ci.sortable = true
    }
    ci.width = colWidths[ colId ]
    slickColMap[ colId ] = ci
  }
  return slickColMap
}

/**
 * React component wrapper around SlickGrid
 *
 */
export default class GridPane extends React.Component {
  onDataLoading: Object
  onDataLoaded: Object
  grid: Object
  colWidthsMap: ColWidthMap
  slickColMap: Object
  loadingIndicator: any
  state: { loading: boolean }

  constructor (props: any) {
    super(props)
    this.state = {loading: false}
  }

  isPivoted () {
    return (this.props.appState.vpivots.length > 0)
  }

  ensureData (from: number, to: number) {
    // console.log('ensureData: ', from, to)
    // TODO: Should probably check for initial image not yet loaded
    // onDataLoading.notify({from: from, to: to})
    this.onDataLoaded.notify({from: from, to: to})
  }

  onGridClick (e: any, args: any) {
    var item = this.grid.getDataItem(args.row)
    console.log('onGridClick: item: ', item)
    if (item._isLeaf) {
      return
    }
    let path = []
    for (let i = 0; i < this.props.appState.vpivots.length; i++) {
      path.push(item['_path' + i])
    }
    console.log('item path: ', path)
    if (item._isOpen) {
      actions.closePath(path, this.props.stateRefUpdater)
    } else {
      actions.openPath(path, this.props.stateRefUpdater)
    }
  }

  // Get grid columns based on current column visibility settings:
  getGridCols (dataView: ?Object = null) {
    const showHiddenCols = (global.cmdLineOptions['hidden-cols'] || false)
    const displayCols = this.props.appState.displayColumns

    let gridCols = displayCols.map(cid => this.slickColMap[cid])
    if (this.isPivoted()) {
      this.updateColWidth(dataView, '_pivot')
      let pivotCol = this.slickColMap['_pivot']
      gridCols.unshift(pivotCol)
    }
    if (showHiddenCols) {
      const hiddenColIds = _.difference(_.keys(this.slickColMap), gridCols.map(gc => gc.field))
      console.log('hidden column ids: ', hiddenColIds)
      const hiddenCols = hiddenColIds.map(cid => this.slickColMap[cid])
      gridCols = gridCols.concat(hiddenCols)
    }
    return gridCols
  }

  /* handlers for data loading and completion */
  registerLoadHandlers (grid: any) {
    this.onDataLoading.subscribe(() => {
      console.log('onDataLoading...')
      this.setState({loading: true})
    })
  }

  /* Create grid from the specified set of columns */
  createGrid (columns: any, data: any) {
    this.grid = new Slick.Grid(container, data, columns, gridOptions)

    this.grid.onViewportChanged.subscribe((e, args) => {
      const vp = this.grid.getViewport()
      this.ensureData(vp.top, vp.bottom)
    })

    this.grid.onSort.subscribe((e, args) => {
      // convert back from slickGrid format: */
      const sortKey = args.sortCols.map(sc => [sc.sortCol.field, sc.sortAsc])
      actions.setSortKey(sortKey, this.props.stateRefUpdater)
    })

    this.grid.onClick.subscribe((e, args) => this.onGridClick(e, args))

    this.grid.onColumnsReordered.subscribe((e, args) => {
      const cols = this.grid.getColumns()
      const displayColIds = cols.map(c => c.field).filter(cid => cid[0] !== '_')
      actions.setColumnOrder(displayColIds, this.props.stateRefUpdater)
    })

    this.registerLoadHandlers(this.grid)

    /*
    $(window).resize(() => {
      console.log('window.resize: resizing grid...')
      this.grid.resizeCanvas()
    })
    */
    // load the first page
    this.grid.onViewportChanged.notify()
  }

  updateColWidth (dataView: any, colId: string) {
    const colWidth = getColWidth(dataView, colId)
    this.colWidthsMap[ colId ] = colWidth
    this.slickColMap[ colId ].width = colWidth
  }

  /*
   * update grid from dataView
   */
  updateGrid (dataView: any) {
    if (!this.colWidthsMap) {
      this.colWidthsMap = getInitialColWidthsMap(dataView)
    }
    this.slickColMap = mkSlickColMap(dataView.schema, this.colWidthsMap)
    const gridCols = this.getGridCols(dataView)
    if (!this.grid) {
      console.log('updateGrid: initial update, creating grid...')
      this.createGrid(gridCols, dataView)
      this.grid.resizeCanvas()
    } else {
      this.grid.setColumns(gridCols)
      this.grid.setData(dataView)
    }
    this.grid.invalidateAllRows() // TODO: optimize
    this.grid.updateRowCount()
    this.grid.render()
  }

  /*
   * Generate a request based on current appState and refresh grid
   * from resulting dataView
   */
  fullRefresh () {
    const appState = this.props.appState
    pivotRequest.requestView(appState.rtc, appState)
      .then(dataView => {
        console.log('requestView completed: ', dataView)
        this.updateGrid(dataView)
      })
      .catch(err => {
        console.error('requestView error: ', err, err.stack)
      })
  }

  componentDidMount () {
    this.onDataLoading = new Slick.Event()
    this.onDataLoaded = new Slick.Event()
    this.loadingIndicator = null

    // ??? This event handler seems questionable -- where does this
    // fit in to the overall flow?
    this.onDataLoaded.subscribe((e, args) => {
      console.log('onDataLoaded.')
      for (let i = args.from; i <= args.to; i++) {
        this.grid.invalidateRow(i)
      }

      this.grid.updateRowCount()
      this.grid.render()

      // this.setState({loading: false})
    })
    this.fullRefresh()
  }

  shouldComponentUpdate (nextProps: any, nextState: any) {
    const prevPivots = this.props.appState.vpivots
    const newPivots = nextProps.appState.vpivots

    let ret = false

    // TODO: We should be able to just do a shallow equality compare on appState

    if (!(_.isEqual(prevPivots, newPivots))) {
      ret = true
    }

    if (this.props.appState.showRoot !== nextProps.appState.showRoot) {
      ret = true
    }

    if (!(_.isEqual(this.props.appState.displayColumns,
                    nextProps.appState.displayColumns))) {
      ret = true
    }
    if (!(_.isEqual(this.props.appState.sortKey,
                    nextProps.appState.sortKey))) {
      ret = true
    }

    if (this.props.appState.pivotLeafColumn !== nextProps.pivotLeafColumn) {
      ret = true
    }

    if (this.props.appState.openPaths !== nextProps.appState.openPaths) {
      ret = true
    }
    console.log('GridPane.shouldComponentUpdate returning: ', ret)
    return ret
  }

  render () {
    const lm = this.state.loading ? <LoadingModal /> : null
    return (
      <div>
        <div className='gridPane'>
          <div id='epGrid' className='slickgrid-container full-height' />
        </div>
        {lm}
      </div>
    )
  }

  componentDidUpdate (prevProps: any, prevState: any) {
    this.fullRefresh()
  }
 }
