module.exports = test;

var snyk = require('../../');
var chalk = require('chalk');
var config = require('../../lib/config');
var isCI = require('../../lib/is-ci');
var apiTokenExists = require('../../lib/api-token').exists;
var _ = require('lodash');
var debug = require('debug')('snyk');
var SEVERITIES = require('../../lib/snyk-test/common').SEVERITIES;

// arguments array is 0 or more `path` strings followed by
// an optional `option` object
function test() {
  var args = [].slice.call(arguments, 0);
  var options = {};
  var results = [];
  var resultOptions = [];

  if (typeof args[args.length - 1] === 'object') {
    options = args.pop();
  }

  // populate with default path (cwd) if no path given
  if (args.length ===  0) {
    args.unshift(process.cwd());
  }

  // org fallback to config unless specified
  options.org = options.org || config.org;

  // making `show-vulnerable-paths` true by default.
  options.showVulnPaths = (options['show-vulnerable-paths'] || '')
    .toLowerCase() !== 'false';

  if (options['severity-threshold']) {
    // HACK: validation should happen at cli/args.js
    // but cli/index is not ready for it
    if (!validateSeverityThreshold(options['severity-threshold'])) {
      return Promise.reject(new Error('INVALID_SEVERITY_THRESHOLD'));
    }
    options.severityThreshold = options['severity-threshold'];
  }

  return apiTokenExists('snyk test')
  .then(function () {
    // Promise waterfall to test all other paths sequentially
    var testsPromises = args.reduce(function (acc, path) {
      return acc.then(function (res) {
        // Create a copy of the options so a specific test can modify them
        // i.e. add `options.file` etc. We'll need these options later.
        var testOpts = _.cloneDeep(options);
        testOpts.path = path;
        resultOptions.push(testOpts);

        // run the actual test
        return snyk.test(path, testOpts)
        .catch(function (error) {
          // Possible error cases:
          // - the test found some vulns. `error.message` is a JSON-stringified
          //   test result.
          // - the flow failed, `error` is a real Error object.
          // - the flow failed, `error` is a number or string describing the
          //   problem.
          //
          // To standardise this, make sure we use the best _object_ to
          // describe the error.
          if (error instanceof Error) {
            return error;
          }

          if (typeof error !== 'object') {
            return new Error(error);
          }

          try {
            return JSON.parse(error.message);
          } catch (unused) {
            return error;
          }
        })
        .then(function (res) {
          // add the tested path to the result of the test (or error)
          results.push(_.assign(res, {path: path}));
        });
      });
    }, Promise.resolve());

    return testsPromises;
  }).then(function () {
    // resultOptions is now an array of 1 or more options used for the tests
    // results is now an array of 1 or more test results
    // values depend on `options.json` value - string or object
    if (options.json) {
      results = results.map(function (result) {
        // add json for when thrown exception
        if (result instanceof Error) {
          return {ok: false, error: result.message, path: result.path};
        }
        return result;
      });

      // backwards compat - strip array IFF only one result
      var dataToSend = results.length === 1 ? results[0] : results;
      var json = JSON.stringify(dataToSend, '', 2);

      if (results.every(function (res) { return res.ok; })) {
        return json;
      }

      throw new Error(json);
    }

    var response = results.map(function (unused, i) {
      return displayResult(results[i], resultOptions[i]);
    }).join('\n----------------------------------------\n');

    var vulnerableResults = results.filter(res => {
      return res.vulnerabilities && res.vulnerabilities.length;
    });
    var errorResults =
      results.filter(res => (res instanceof Error));

    var summaryMessage = '';

    if (results.length > 1) {
      var projects = results.length === 1 ? ' project' : ' projects';
      summaryMessage = '\n\nTested ' + results.length + projects +
        summariseVulnerableResults(vulnerableResults, options) +
        summariseErrorResults(errorResults);
    }

    var notSuccess = vulnerableResults.length > 0 || errorResults.length > 0;

    if (notSuccess) {
      response += chalk.bold.red(summaryMessage);
      const error = new Error(response);
      // take the code of the first problem to go through error translation
      // HACK as there can be different errors, and we pass only the first one
      error.code = (vulnerableResults[0] || errorResults[0]).code;
      throw error;
    }

    response += chalk.bold.green(summaryMessage);
    return response;
  });
}

function summariseVulnerableResults(vulnerableResults, options) {
  if (vulnerableResults.length) {
    if (options.showVulnPaths) {
      return ', ' + vulnerableResults.length + ' contained vulnerable paths.';
    }
    return ', ' + vulnerableResults.length + ' had issues.';
  }

  if (options.showVulnPaths) {
    return ', no vulnerable paths were found.';
  }

  return ', no issues were found.';
}

function summariseErrorResults(errorResults) {
  const projects = errorResults.length > 1 ? ' projects' :  ' project';
  if (errorResults.length > 0) {
    return ' Failed to test ' + errorResults.length + projects +
      '.\nRun with `-d` for debug output and contact support@snyk.io';
  }

  return '';
}

function displayResult(res, options) {
  var meta = metaForDisplay(res, options) + '\n\n';
  var packageManager = options.packageManager;
  var prefix = '\nTesting ' + options.path + '...\n';
  var summary = 'Tested ';

  // handle errors by extracting their message
  if (res instanceof Error) {
    return prefix + res.message;
  }

  // real `test` result object, let's describe it
  if (res.hasOwnProperty('dependencyCount')) {
    summary += res.dependencyCount + ' dependencies';
  } else {
    summary += options.path;
  }
  var issues = res.licensesPolicy ? 'issues' : 'vulnerabilities';
  summary += ' for known ' + issues;

  if (res.ok && res.vulnerabilities.length === 0) {
    var vulnPaths = options.showVulnPaths ?
          ', no vulnerable paths found.' :
          ', none were found.';
    summary = chalk.green('✓ ' + summary + vulnPaths);

    if (!isCI) {
      summary += '\n\nNext steps:\n- Run `snyk monitor` to be notified ' +
        'about new related vulnerabilities.\n- Run `snyk test` as part of ' +
        'your CI/test.';
    }
    return prefix + meta + summary;
  }

  var vulnLength = res.vulnerabilities && res.vulnerabilities.length;
  var count = 'found ' + res.uniqueCount;
  if (res.uniqueCount === 1) {
    var issue = res.licensesPolicy ? 'issue' : 'vulnerability';
    count += ' ' + issue + ', ';
  } else {
    count += ' ' + (res.licensesPolicy ? 'issues' : 'vulnerabilities') + ', ';
  }
  if (options.showVulnPaths) {
    count += vulnLength + ' vulnerable ';

    if (res.vulnerabilities && res.vulnerabilities.length === 1) {
      count += 'path.';
    } else {
      count += 'paths.';
    }
  } else {
    count = count.slice(0, -2) + '.'; // replace ', ' with dot
  }
  summary = summary + ', ' + chalk.red.bold(count);

  if (packageManager === 'npm' || packageManager === 'yarn') {
    summary += '\n\nRun `snyk wizard` to address these issues.';
  }

  var sep = '\n\n';

  var reportedVulns = {};
  var body = (res.vulnerabilities || []).map(function (vuln) {
    if (!options.showVulnPaths && reportedVulns[vuln.id]) { return; }
    reportedVulns[vuln.id] = true;

    var res = '';
    var name = vuln.name + '@' + vuln.version;
    var severity = vuln.severity[0].toUpperCase() + vuln.severity.slice(1);
    var issue = vuln.type === 'license' ? 'issue' : 'vulnerability';
    res += chalk.red('✗ ' + severity + ' severity ' + issue + ' found on ' +
      name + '\n');
    res += '- desc: ' + vuln.title + '\n';
    res += '- info: ' + config.ROOT + '/vuln/' + vuln.id + '\n';
    if (options.showVulnPaths) {
      res += '- from: ' + vuln.from.join(' > ') + '\n';
    }

    if (vuln.note) {
      res += vuln.note + '\n';
    }

    // none of the output past this point is relevant if we're not displaying
    // vulnerable paths
    if (!options.showVulnPaths) {
      return res.trim();
    }

    var upgradeSteps = (vuln.upgradePath || []).filter(Boolean);

    // Remediation instructions (if we have one)
    if (upgradeSteps.length) {

      // Create upgrade text
      var upgradeText = upgradeSteps.shift();
      upgradeText += (upgradeSteps.length) ?
          ' (triggers upgrades to ' + upgradeSteps.join(' > ') + ')' : '';

      var fix = ''; // = 'Fix:\n';
      for (var idx = 0; idx < vuln.upgradePath.length; idx++) {
        var elem = vuln.upgradePath[idx];

        if (elem) {
          // Check if we're suggesting to upgrade to ourselves.
          if (vuln.from.length > idx && vuln.from[idx] === elem) {
            // This ver should get the not-vuln dependency, suggest refresh
            fix += 'Your dependencies are out of date, otherwise you would ' +
              'be using a newer ' + vuln.name + ' than ' + vuln.name + '@' +
              vuln.version + '.\n';
            if (packageManager === 'npm') {
              fix += 'Try deleting node_modules, reinstalling ' +
              'and running `snyk test` again.\nIf the problem persists, ' +
              'one of your dependencies may be bundling outdated modules.';
            } else if (packageManager === 'rubygems') {
              fix += 'Try running `bundle update ' + vuln.name + '` ' +
              'and running `snyk test` again.';
            }
            break;
          }
          if (idx === 0) {
            // This is an outdated version of yourself
            fix += 'You\'ve tested an outdated version of the project. ' +
              'Should be upgraded to ' + upgradeText;
          } else if (idx === 1) {
            // A direct dependency needs upgrade. Nothing to add.
            fix += 'Upgrade direct dependency ' + vuln.from[idx] +
              ' to ' + upgradeText;
          } else {
            // A deep dependency needs to be upgraded
            res += 'No direct dependency upgrade can address this issue.\n' +
              chalk.bold('Run `snyk wizard` to explore remediation options.');
          }
          break;
        }

      }
      res += chalk.bold(fix);
    } else {
      if (vuln.type === 'license') {
        // do not display fix (there isn't any), remove newline
        res = res.slice(0, -1);
      } else if (packageManager === 'npm') {
        res += chalk.magenta(
          'Fix: None available. Consider removing this dependency.');
      }
    }
    return res;
  }).filter(Boolean).join(sep) + sep + meta + summary;

  return prefix + body;
}

function metaForDisplay(res, options) {
  var meta = [
    chalk.bold('Organisation:    ') + res.org,
    chalk.bold('Package manager: ') +
      (options.packageManager || res.packageManager),
    chalk.bold('Target file:     ') + options.file,
    chalk.bold('Open source:     ') + (res.isPrivate ? 'no' : 'yes'),
    chalk.bold('Project path:    ') + options.path,
  ];
  if (res.filesystemPolicy) {
    meta.push('Local Snyk policy found');
    if (res.ignoreSettings && res.ignoreSettings.disregardFilesystemIgnores) {
      meta.push('Local Snyk policy ignores disregarded');
    }
  }
  if (res.licensesPolicy) {
    meta.push('Licenses enabled');
  }

  return meta.join('\n');
}

function validateSeverityThreshold(severityThreshold) {
  return SEVERITIES.indexOf(severityThreshold) > -1;
}
