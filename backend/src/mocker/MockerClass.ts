import data from './data'
import {EventEmitter} from 'events'

export default class MockerClass extends EventEmitter {

    data: Array<object>;
    timeoutList: Array<NodeJS.Timeout>;

    constructor() {
        super();

        this.data = data;
        this.timeoutList = [];
    }

    start() {
        // Clear any previous run
        this.timeoutList.forEach(h => clearTimeout(h));
        this.timeoutList = [];
        // Deep-clone data so `delete element.time` doesn't mutate the original
        const clone = JSON.parse(JSON.stringify(this.data));
        this.parseData(clone);
    }


    // Parse data into event listen
    parseData(data: Array<object>){

        // Track the latest scheduled time so we can fire a 'done' event after
        // every action has been emitted — lets callers emit ktp_match_end and
        // exit cleanly instead of looping forever.
        let maxTime = 0;

        // Map over values of event list
        data.forEach((object: object, index: number) => {

            // Get key value by using value position
            const key = Object.keys(object);
            const element = Object.values(object)[0];


            // Throw error since this is needed to schedule our timer
            if(element.time === undefined){ throw new Error("time object property is required"); }

            if (element.time > maxTime) maxTime = element.time;

            // Create an handle
            const handle = setTimeout(() =>{

                // Delete time property since this is not needed on frontend anymore?
                delete element.time;

                // Emit event with key and value
                this.emit('action', [key, element])

            }, element.time)

            // Push handle into array, gonna use it later for clearing event list.
            this.timeoutList.push(handle);

        });

        // Fire 'done' 100ms after the last action so any listener POSTing its
        // envelope has a chance to flush before we announce completion.
        const doneHandle = setTimeout(() => this.emit('done'), maxTime + 100);
        this.timeoutList.push(doneHandle);
    }


}

