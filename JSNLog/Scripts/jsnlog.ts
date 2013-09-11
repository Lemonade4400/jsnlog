/// <reference path="jsnlog_interfaces.d.ts"/>

function JL(loggerName?: string): JSNLogLogger {
    
    // If name is empty, return the root logger
    if (!loggerName) {
        return JL.__;
    }

    var ancestorName='';
    var logger: JL.Logger = ('.' + loggerName).split('.').reduce(
        function (prev: JL.Logger, curr: string, idx: number, arr: string[]) { 
            // if loggername is a.b, than ancestor will be set to the loggers
            // root   (prev: JL, curr: '')
            // a      (prev: JL.__, curr: 'a')
            // a.b    (prev: JL.__.__a, curr: 'b')

            var ancestor = prev['__' + curr];
        
            // ancestorName evaluates false ('' is falsy) in first iteration when prev is the root logger.
            // ancestorName will be the logger name corresponding with the logger in ancestor.
            // Keep in mind that the ancestor may not be defined yet, so can't get the name from
            // the ancestor object itself.
            if (ancestorName) { ancestorName += '.' + curr; } else { ancestorName = curr; }

            // If the ancestor (or the actual logger being sought) does not yet exist, 
            // create it now.
            if (ancestor === undefined) {

                // Set the prototype of the Logger constructor function to the parent of the logger
                // to be created. This way, __proto of the new logger object will point at the parent.
                // When logger.level is evaluated and is not present, the JavaScript runtime will 
                // walk down the prototype chain to find the first ancestor with a level property.
                //
                // Note that prev at this point refers to the parent logger.

                <any>JL.Logger.prototype = prev;

                ancestor = new JL.Logger(ancestorName);
                prev['__' + curr] = ancestor;  
            }
        
            return ancestor;
        }, JL.__);

    return logger;
}

module JL {

    export var enabled: boolean;
    export var clientIP: string;
    export var requestId: string;

    /**
    Copies the value of a property from one object to the other.
    This is used to copy property values as part of setOption for loggers and appenders.

    Because loggers inherit property values from their parents, it is important never to
    create a property on a logger if the intent is to inherit from the parent.

    Copying rules:
    1) if the from property is undefined (for example, not mentioned in a JSON object), the
       to property is not affected at all.
    2) if the from property is null, the to property is deleted (so the logger will inherit from
       its parent).
    3) Otherwise, the from property is copied to the to property.
    */
    function copyProperty(propertyName: string, from: any, to: any): void {
        if (from[propertyName] === undefined) { return; }
        if (from[propertyName] === null) { delete to[propertyName]; return; }
        to[propertyName] = from[propertyName];
    }

    /**
    Returns true if a log should go ahead.
    Does not check level.

    @param filters
        Filters that determine whether a log can go ahead.
    */
    function allow(filters: JSNLogFilterOptions): boolean {
        // If enabled is not null or undefined, then if it is false, then return false
        // Note that undefined==null (!)
        if (!(JL.enabled == null)) {
            if (!JL.enabled) { return false; }
        }

        // If the regex contains a bug, that will throw an exception.
        // Ignore this, and pass the log item (better too much than too little).

        try {
            if (filters.userAgentRegex) {
                if (!new RegExp(filters.userAgentRegex).test(navigator.userAgent)) { return false; }
            }
        } catch (e) { }

        try {
            if (filters.ipRegex && JL.clientIP) {
                if (!new RegExp(filters.ipRegex).test(JL.clientIP)) { return false; }
            }
        } catch (e) { }

        return true;
    }

    export function setOptions(options: JSNLogOptions): JSNLogStatic {
        copyProperty("enabled", options, this);
        copyProperty("clientIP", options, this);
        copyProperty("requestId", options, this);
        return this;
    }

    export function getAllLevel(): number { return -2147483648; }
    export function getTraceLevel(): number { return 1000; }
    export function getDebugLevel(): number { return 2000; }
    export function getInfoLevel(): number { return 3000; }
    export function getWarnLevel(): number { return 4000; }
    export function getErrorLevel(): number { return 5000; }
    export function getFatalLevel(): number { return 6000; }
    export function getOffLevel(): number { return 2147483647; }

    // ---------------------

    export class LogItem {
        // l: level
        // m: message
        // n: logger name
        // t (timeStamp) is number of milliseconds since 1 January 1970 00:00:00 UTC
        //
        // Keeping the property names really short, because they will be sent in the
        // JSON payload to the server.
        constructor(public l: number, public m: string,
            public n: string, public t: number) {}
    }

    // ---------------------

    export class Appender implements JSNLogAppender, JSNLogFilterOptions {
        public level: number = JL.getTraceLevel();
        public ipRegex: string;
        public userAgentRegex: string;

        // set to super high level, so if user increases level, level is unlikely to get 
        // above sendWithBufferLevel
        private sendWithBufferLevel: number = 2147483647; 

        private storeInBufferLevel: number = -2147483648;
        private bufferSize: number = 0; // buffering switch off by default
        private batchSize: number = 1;

        // Holds all log items with levels higher than storeInBufferLevel 
        // but lower than level. These items may never be sent.
        private buffer: LogItem[] = [];

        // Holds all items that we do want to send, until we have a full
        // batch (as determined by batchSize).
        private batchBuffer: LogItem[] = [];

        // sendLogItems takes an array of log items. It will be called when
        // the appender has items to process (such as, send to the server).
        // Note that after sendLogItems returns, the appender may truncate
        // the LogItem array, so the function has to copy the content of the array
        // in some fashion (eg. serialize) before returning.

        constructor(
            public appenderName: string, 
            public sendLogItems: (logItems: LogItem[]) => void) { 
        }

        public setOptions(options: JSNLogAppenderOptions): JSNLogAppender {
            copyProperty("level", options, this);
            copyProperty("ipRegex", options, this);
            copyProperty("userAgentRegex", options, this);
            copyProperty("sendWithBufferLevel", options, this);
            copyProperty("storeInBufferLevel", options, this);
            copyProperty("bufferSize", options, this);
            copyProperty("batchSize", options, this);

            if (this.bufferSize < this.buffer.length) { this.buffer.length = this.bufferSize; }

            return this;
        }

        /**
        Called by a logger to log a log item.
        If in response to this call one or more log items need to be processed
        (eg., sent to the server), this method calls this.sendLogItems
        with an array with all items to be processed.
        */
        public log(level: number, message: string, loggerName: string): void {
            var logItem: LogItem;

            if (!allow(this)) { return; }

            if (level < this.storeInBufferLevel) {
                // Ignore the log item completely
                return;
            } 

            logItem = new LogItem(level, message, loggerName, (new Date).getTime());

            if (level < this.level) {
                // Store in the hold buffer. Do not send.
                if (this.bufferSize > 0) {
                    this.buffer.push(logItem);

                    // If we exceeded max buffer size, remove oldest item
                    if (this.buffer.length > this.bufferSize) {
                        this.buffer.shift();
                    }
                }

                return;
            }
                
            if (level < this.sendWithBufferLevel) {
                // Want to send the item, but not the contents of the buffer
                this.batchBuffer.push(logItem);

            } else {
                // Want to send both the item and the contents of the buffer.
                // Send contents of buffer first, because logically they happened first.
                if (this.buffer.length) {
                    this.batchBuffer = this.batchBuffer.concat(this.buffer);
                    this.buffer.length = 0;
                }
                this.batchBuffer.push(logItem);
            }

            if (this.batchBuffer.length >= this.batchSize) {
                this.sendBatch();
                return;
            }
        }

        // Processes the batch buffer
        private sendBatch(): void {
            if (this.batchBuffer.length == 0) {
                return;
            }

            this.sendLogItems(this.batchBuffer);
            this.batchBuffer.length = 0;
        }
    }

    // ---------------------

    export class AjaxAppender extends Appender implements JSNLogAjaxAppender {
        private url: string = "jsnlog.logger";

        public setOptions(options: JSNLogAjaxAppenderOptions): JSNLogAjaxAppender {
            copyProperty("url", options, this);
            super.setOptions(options);
            return this;
        }

        public sendLogItemsAjax(logItems: LogItem[]): void {
            // JSON.stringify is only supported on IE8+
            // Use try-catch in case we get an exception here.
            try {
                var json: string = JSON.stringify({
                    r: JL.requestId,
                    lg: logItems
                });

                // Send the json to the server. 
                // Note that there is no event handling here. If the send is not
                // successful, nothing can be done about it.

                var xhr = new XMLHttpRequest();
                xhr.open('POST', this.url);

                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(json);
            } catch (e) { }
        }

        constructor(appenderName: string) {
            super(appenderName, AjaxAppender.prototype.sendLogItemsAjax);
        }
    }

    // --------------------

    export class Logger implements JSNLogLogger, JSNLogFilterOptions {
        public appenders: Appender[];

        public level: number;
        public userAgentRegex: string;
        public ipRegex: string;

        constructor(public loggerName: string) {
        }

        public setOptions(options: JSNLogLoggerOptions): JSNLogLogger {
            copyProperty("level", options, this);
            copyProperty("userAgentRegex", options, this);
            copyProperty("ipRegex", options, this);
            copyProperty("appenders", options, this);

            return this;
        }

        public log(level: number, message: string): JSNLogLogger {
            var i: number = 0;

            // If we can't find any appenders, do nothing
            if (!this.appenders) { return; }

            if (((level >= this.level)) && allow(this)) {
                i = this.appenders.length - 1;
                while (i >= 0) {
                    this.appenders[i].log(level, message, this.loggerName);
                    i--;
                }
            }

            return this;
        }

        public trace(message: string): JSNLogLogger { return this.log(getTraceLevel(), message); }
        public debug(message: string): JSNLogLogger { return this.log(getDebugLevel(), message); }
        public info(message: string): JSNLogLogger { return this.log(getInfoLevel(), message); }
        public warn(message: string): JSNLogLogger { return this.log(getWarnLevel(), message); }
        public error(message: string): JSNLogLogger { return this.log(getErrorLevel(), message); }
        public fatal(message: string): JSNLogLogger { return this.log(getFatalLevel(), message); }
    }

    // -----------------------

    var defaultAppender = new AjaxAppender("");

    // Create root logger
    //
    // Note that this is the parent of all other loggers.
    // Logger "x" will be stored at
    // JL.__.x
    // Logger "x.y" at
    // JL.__.x.y
    export var __ = new JL.Logger("");
    JL.__.setOptions(
        {
            level: JL.getDebugLevel(),
            appenders: [defaultAppender]
        });

    export function createAjaxAppender(appenderName: string): JSNLogAjaxAppender {
        return new AjaxAppender(appenderName);
    }
}


