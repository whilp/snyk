/* jshint expr:true */
import {expect} from 'chai';
import {
    describeComponent,
    it
} from 'ember-mocha';

describeComponent(
    'gh-editor-save-button',
    'GhEditorSaveButtonComponent',
    {
        needs: [
            'component:gh-dropdown-button',
            'component:gh-dropdown',
            'service:dropdown'
        ]
    },
    function () {
        it('renders', function () {
            // creates the component instance
            var component = this.subject();

            expect(component._state).to.equal('preRender');

            // renders the component on the page
            this.render();
            expect(component._state).to.equal('inDOM');
        });
    }
);
