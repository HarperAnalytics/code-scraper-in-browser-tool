// Source code repository: https://github.com/frabcus/code-scraper-in-browser-tool/

var settings
var editor
var editorDirty = false
var editorShare
var editorSpinner
var output
var outputSpinner
var status = 'nothing' // currently belief about script execution status: 'running' or 'nothing'
var changing ='' // for starting/stopping states
var stateShare // various things shared with share.js, including group consideration of the running status
var saveTimeout // store handle to timeout so can clear it
var connected = false // whether sharejs is connected - measured by sharejs
var online = true // whether browser is online - measured by errors from calling exec endpoint

// This is an arbitary number we tack onto the end of the document id in ShareJS.
// Incrementing it forces the code in the browser tool to use a new ShareJS
// document (and recover the data from the code/scraper file to initialise it)
var shareJSCode = '046'

// Spinner options
var spinnerOpts = {
  lines: 12, // The number of lines to draw
  length: 7, // The length of each line
  width: 4, // The line thickness
  radius: 10, // The radius of the inner circle
  corners: 1, // Corner roundness (0..1)
  rotate: 0, // The rotation offset
  direction: 1, // 1: clockwise, -1: counterclockwise
  color: '#fff', // #rgb or #rrggbb
  speed: 1, // Rounds per second
  trail: 60, // Afterglow percentage
  shadow: false, // Whether to render a shadow
  hwaccel: false, // Whether to use hardware acceleration
  className: 'spinner', // The CSS class to assign to the spinner
  zIndex: 2e9, // The z-index (defaults to 2000000000)
  top: 'auto', // Top position relative to parent in px
  left: 'auto' // Left position relative to parent in px
};

// Called when we either load from the box filesystem, or get data from 
//ShareJS, upon first loading of the page
var done_initial_load = function() {
  // set syntax highlighting a tick later, when we have initial data
  setTimeout(function() {
    //console.log('editor version', editorShare.version, editor.getValue())
    set_editor_mode(editor.getValue())
    editor.setReadOnly(false)
    editor.moveCursorTo(0, 0)
    editor.focus()
    editorSpinner.stop()
  }, 1)
}

// Wire up shared document on the connection
var made_editor_connection = function(error, doc) {
  if (error) {
    console.log("sharing doc error", error)
    scraperwiki.alert("Trouble setting up pair editing!", error, true)
    return
  }
  console.log("shared doc")

  editorShare = doc
  editorShare.attach_ace(editor)

  if (editorShare.created) {
    console.log("first time this editor document exists on ShareJS server, loading from filesystem")
    load_code_from_file()
  } else {
    done_initial_load()
  }

  editorShare.on('error', function(error) {
    console.log("editorShare later error:", error)
    // if ShareJS server has restarted, we get document missing as an error
    // just redo everything in this case
    if (error == "Document does not exist")
      location.reload()
    else
      scraperwiki.alert("Editor sharing error!", error, true)
  })
}

// Wire up shared state on the connection
var made_state_connection = function(error, doc) {
  if (error) {
    console.log("sharing state error", error)
    scraperwiki.alert("Trouble setting up pair state!", error, true)
    return
  }
  console.log("shared state")

  stateShare = doc
  if (stateShare.created) {
    console.log("first time this state document exists on ShareJS server, initialising with 'nothing'")
    stateShare.submitOp([{p:[],od:null,oi:{status:'nothing'}}])
  }
  stateShare.on('change', function (op) {
    shared_state_update(op)
  })
  stateShare.on('error', function (error) {
    console.log("stateShare later error:", error)
    // if ShareJS server has restarted, we get document missing as an error
    // just redo everything in this case
    if (error == "Document does not exist")
      location.reload()
    else
      scraperwiki.alert("State sharing error!", error, true)
  })
}

// When a language is selected
var do_language_picked = function(el) {
  var picked_lang = el.target.href.split("#")[1]
  console.log("lang=", picked_lang)
  data = "#!/usr/bin/env xxx"
  $.each(languages, function(ix, lang) {
    if (lang.binary == picked_lang) {
      data = "#!/usr/bin/env " + lang.binary
      if (lang.params) {
        data += " " + lang.params
      }
    }
  })
  set_loaded_data(data)
  $('#languagepicker').hide()
  return false
}


// Called after either loading the code from filesystem, or first time through with new language
var set_loaded_data = function(data) {
  clear_alerts()
  set_editor_mode(data)
  editor.setValue(data) // XXX this overrides what is in filesystem on top of what is in sharejs
  update_dirty(false)
  done_initial_load()
}

// Used to initialise what is in the ShareJS server from the filesystem the
// first time run for the instantiation of the ShareJS server.
var load_code_from_file = function() {
  console.log("loading...")
  scraperwiki.exec('mkdir -p code && touch code/scraper && cat code/scraper && echo -n swinternalGOTCODEOFSCRAPER', function(data) {
    if (data.indexOf("swinternalGOTCODEOFSCRAPER") == -1) {
      scraperwiki.alert("Trouble loading code!", data, true)
      return
    }
    data = data.replace("swinternalGOTCODEOFSCRAPER", "")
    online = true

    // If nothing there, set some default content to get people going
    if (data.match(/^\s*$/)) {
      $('#languagepicker').show()
    } else {
      console.log("...loaded")
      set_loaded_data(data)
    }
  }, handle_exec_error)
}

// Handle error
var handle_exec_error = function(jqXHR, textStatus, errorThrown) {
    console.log("got an error:", errorThrown, jqXHR, textStatus)
    // Handle special case of the browser not being connected to the net
    // http://stackoverflow.com/questions/10026204/dialog-box-if-there-is-no-internet-connection-using-jquery-or-ajax
    if (jqXHR.status == 0) { 
      // Wait half a second before error - otherwise they show on page refresh,
      // we only want to show if the browser is disconneted from the network.
      setTimeout(function() {
        clear_alerts()
        online = false
        refresh_saving_message()
      } , 500)
    } else {
      scraperwiki.alert(errorThrown, $(jqXHR.responseText).text(), "error")
    }
}

// Display whether we have unsaved edits,
var update_dirty = function(value) {
  editorDirty = value
  refresh_saving_message()
}

// Refresh the saving and so on text
var refresh_saving_message = function() {
  clearTimeout(saveTimeout)

  if (!online) {
    $("#saved").text("")
    $("#offline").text("Offline, not connected to the Internet")
    return
  }
  if (!connected) {
    $("#saved").text("")
    $("#offline").text("Offline, can't connect to the sharing server")
    return
  }

  $("#offline").text("")
  if (editorDirty) {
    // Wait three seconds and then save. If we get another change
    // in those three seconds, reset that timer to avoid excess saves.
    saveTimeout = setTimeout(save_code, 3000)
    //$("#saved").text("Saving...")
  } else {
    //$("#saved").text("All changes saved")
  } 
}


// Prevent navigation away if not saved
// XXX this doesn't seem to work for close events in chrome in the frame
$(window).on('beforeunload', function() {
  if (editorDirty) {
    return "You've made changes that haven't been saved yet."
  }
})

// Work out language we're in from the shebang line
var set_editor_mode = function(code) {
  var first = code.split("\n")[0]
  if (first.substr(0,2) != "#!") {
    scraperwiki.alert("Specify language in the first line!", "For example, put <code class='inserterHit'>#!/usr/bin/env node</code>, <code class='inserterHit'>#!/usr/bin/env Rscript</code> or <code class='inserterHit'>#!/usr/bin/env python</code>.", false)
    $('.inserterHit').click(function() {
      var line = $(this).text() + "\n\n"
      editor.moveCursorTo(0,0)
      editor.insert(line)
      editor.focus()
    })
    return false
  }

  // Please add more as you need them and send us a pull request!
  editor.getSession().setMode("ace/mode/text")
  $.each(languages, function(ix, lang) {
    if (first.indexOf(lang.binary) != -1) {
      editor.getSession().setMode("ace/mode/" + lang.highlight)
      return false
    }
  })

  return true
}

// Got a new state over ShareJS (from ourselves or remote clients)
var shared_state_update = function(op) {
  //console.log("shared_state_update", stateShare.snapshot)

  // Respond to the status change
  var new_status = stateShare.snapshot.status
  if (new_status != status) {
    console.log("status change", status, "===>", new_status)
    if (new_status == "running") {
      enrunerate_and_poll_output()
    }
    status = new_status
    changing = ""
  }
  update_display_from_status(new_status)
}

// Show status in buttons - we have this as we can call it directly
// to make the run button seem more responsive
var update_display_from_status = function(use_status) {
  $("#run").removeClass("btn-primary").removeClass("btn-danger").removeClass("btn-warning").removeClass("btn-success").removeClass('loading')
  if (changing == "starting") {
    $("#run").text("Starting...").addClass("btn-warning").addClass('loading')
  } else if (changing == "stopping") {
    $("#run").text("Stopping...").addClass("btn-danger").addClass('loading')
  } else if (use_status == "running") {
    $("#run").text("Running...").addClass("btn-success").addClass('loading')
  } else if (use_status == "nothing") {
    $("#run").text("Run!").addClass("btn-primary")
  }
}

// Show/hide things according to current state
var set_status = function(new_status) {
  if (!online || !connected || !stateShare) {
    return
  }

  if (new_status != "running" && new_status != "nothing") {
    scraperwiki.alert("Unknown new status!", new_status, true)
    return
  }

  // Tell other ShareJS clients the status has changed
  try {
    stateShare.submitOp( {p:['status'],od:status,oi:new_status})
  } catch (e) {
    scraperwiki.alert("Error saving to ShareJS!", e, true)
  }
}

// Check status of running script, and get more output as appropriate
var enrunerate_and_poll_output = function(action) {
  action = action || ""
  command = "./tool/enrunerate " + action
  if (action == "run") {
    command = "(export GIT_AUTHOR_NAME='Anonymous'; cd code; git init; git add scraper; git commit -am 'Ran code in browser') >/dev/null; " + command
  }

  scraperwiki.exec(command, function(text) {
    console.log("enrunerate:", text)
    online = true
    set_status(text)

    // we poll one last time either way to be sure we get end of output...
    var again = false
    if (text == "running") {
      // ... but if script is still "running" we'll trigger the timer to do it again
      again = true
    }
    scraperwiki.exec("cat logs/out", function(text) {
      // XXX detect no file a better way
      if (text != "cat: logs/out: No such file or directory\n") {
        output.setValue(text)
      }
      outputSpinner.stop()
      output.clearSelection()
      if (again) {
        setTimeout(enrunerate_and_poll_output, 10)
      }
    }, handle_exec_error)
  }, handle_exec_error)
}

// Clear any errors
var clear_alerts = function() {
  $(".alert").remove()
}

// Save the code - optionally takes text of extra commands to also 
// in the same "exec" and a callback to run when done
var save_code = function(callback) {
  clearTimeout(saveTimeout) // stop any already scheduled timed saves

  if (!editorShare) {
    console.log("not saving, no share connection")
    return
  }

  console.log("save_code... version", editorShare.version)
  var code = editor.getValue()
  var sep = ""
  if (code.length == 0 || code.charAt(code.length - 1) != "\n") {
    sep = "\n" // we need a separator \n at the end of the file for the ENDOFSCRAPER heredoc below
  }
  var cmd = "cat >code/scraper.new.$$ <<\"ENDOFSCRAPER\" &&\n" + code + sep + "ENDOFSCRAPER\n"
  cmd = cmd + "chmod a+x code/scraper.new.$$ && mv code/scraper.new.$$ code/scraper"
  scraperwiki.exec(cmd, function(text) {
    if (text != "") {
        scraperwiki.alert("Trouble saving code!", text, true)
        return
    }
    online = true

    // Check actual content against saved - in case there was a change while we executed
    if (editor.getValue() == code) {
      console.log("Saved fine without interference")
      update_dirty(false)
    } else {
      console.log("Ooops, it got dirty while saving")
      update_dirty(true)
    }

    if (callback) {
      callback(text)
    }
  }, handle_exec_error)
}

// When the "bugs" button is pressed
var do_bugs = function() {
  window.open("https://github.com/frabcus/code-scraper-in-browser-tool/issues", "_blank")
}

// When the "run" button is pressed
var do_run = function() {
  // force a check that we have a shebang (#!) line
  clear_alerts()
  var code = editor.getValue()
  if (!set_editor_mode(code)) {
    return
  }

  // if it is already running, stop instead
  if (status == "running") {
    // make button show what we're doing
    changing = "stopping"
    update_display_from_status(status)
    // stop the running code
    enrunerate_and_poll_output("stop")
    return
  }

  // make button show what we're doing
  changing = "starting"
  update_display_from_status(status)
  output.setValue("")
  // save code and run it
  if (editorDirty) {
    save_code(function (text) {
      enrunerate_and_poll_output("run")
    })
  } else {
    enrunerate_and_poll_output("run")
  }
}

// Main entry point
$(document).ready(function() {
  settings = scraperwiki.readSettings()

  // Create editor window, read only until it is ready
  editor = ace.edit("editor")
  editor.getSession().setUseSoftTabs(true)
  editor.setTheme("ace/theme/monokai")
  editor.on('change', function() {
    update_dirty(true)
  })
  editor.setReadOnly(true)
  editorSpinner = new Spinner(spinnerOpts).spin($('#editor')[0])

  // Initialise the ShareJS connections - it will automaticaly reuse the connection
  console.log("connecting...")
  // ... for now we use the publish token. We should use the API key, when it is per dataset not per user.
  var access_token = settings.source.publishToken
  connection = sharejs.open('scraperwiki-' + scraperwiki.box + '-' + access_token + '-doc' + shareJSCode, 'text', 'http://seagrass.goatchurch.org.uk/sharejs/channel', made_editor_connection)
  sharejs.open('scraperwiki-' + scraperwiki.box + '-' + access_token + '-state' + shareJSCode, 'json', 'http://seagrass.goatchurch.org.uk/sharejs/channel', made_state_connection)
  connection.on("error", function(e) {
    console.log("sharejs connection: error")
    connected = false
    refresh_saving_message()
  })
  connection.on("ok", function(e) {
    console.log("sharejs connection: ok")
    connected = true
    online = true
    refresh_saving_message()
  })

  // Create the console output window
  output = ace.edit("output")
  output.setTheme("ace/theme/monokai")
  // ... we use /bin/sh syntax highlighting, the only other at all
  // credible option for such varied output is plain text, which is dull.
  output.getSession().setMode("ace/mode/sh")
  outputSpinner = new Spinner(spinnerOpts).spin($('#output')[0])
  enrunerate_and_poll_output()

  // Fill in the language picker
  $.each(languages, function(ix, lang) {
    $("#languagepicker ul").append('<li><a href="#' + lang.binary + '">' + lang.human + ' <span style="display: none" class="pull-right muted">#! ' + lang.binary + '</span></a></li>')
  })
  $('#languagepicker a').on('click', do_language_picked)

  // Bind all the buttons to do something
  $('#bugs').on('click', do_bugs)
  $('#run').on('click', do_run)
  $('[title]').tooltip()

  $(document).on('keydown', function(e){
    // the keycode for "enter" is 13
    if((e.ctrlKey || e.metaKey) && e.which==13) {
      do_run()
      e.preventDefault()
    }
  })
})

